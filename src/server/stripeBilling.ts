import Stripe from 'stripe';
import { env } from './env';
import { query } from './dbClient';

export type SubscriptionLevel = 'standard' | 'pro' | 'max';

export type BillingStatus = {
  user: { hasTrialed: boolean };
  subscription: {
    level: SubscriptionLevel;
    status: string | null;
    currentPeriodEnd: string | null;
  } | null;
  tokens: {
    free: number;
    subscription: number;
    purchased: number;
    total: number;
  };
};

export type BillingProduct = {
  id: string;
  stripeProductId: string;
  stripePriceId: string;
  productType: 'subscription' | 'pack';
  subscriptionLevel: SubscriptionLevel | null;
  tokenAmount: number;
  name: string;
  priceCents: number;
  interval: string | null;
  active: boolean;
};

export type ConsumeSuccess = {
  ok: true;
  tokensDeducted: number;
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type ConsumeFailure = {
  ok: false;
  reason: 'insufficient_tokens';
  tokensRequired: number;
  tokensAvailable: number;
  tokensDeducted: number;
};

export type ConsumeResult = ConsumeSuccess | ConsumeFailure;

export type RefundResult = {
  ok: true;
  tokensRefunded: number;
  source: 'free' | 'subscription' | 'purchased';
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type CancelSubscriptionResult =
  | { canceled: true }
  | { canceled: false; reason: 'no_subscription' | 'already_canceled' };

export class BillingClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function getStripe(): Stripe {
  const stripeSecretKey = env('STRIPE_SECRET_KEY');
  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  return new Stripe(stripeSecretKey, {
    apiVersion: '2026-04-22.dahlia' as any,
  });
}

// Cache for products
let productsCache: { subscriptions: BillingProduct[]; packs: BillingProduct[] } | null = null;
let productsCacheTime = 0;
const PRODUCTS_CACHE_TTL = 60_000; // 1 minute

async function getStripeProducts(): Promise<{ subscriptions: BillingProduct[]; packs: BillingProduct[] }> {
  if (productsCache && Date.now() - productsCacheTime < PRODUCTS_CACHE_TTL) {
    return productsCache;
  }

  const prices = await getStripe().prices.list({
    expand: ['data.product'],
    active: true,
  });

  const subscriptions: BillingProduct[] = [];
  const packs: BillingProduct[] = [];

  for (const price of prices.data) {
    const product = price.product as Stripe.Product;
    if (!product) continue;

    const metadata = product.metadata || {};
    const productType = metadata.product_type as 'subscription' | 'pack' | undefined;
    const subscriptionLevel = metadata.subscription_level as 'standard' | 'pro' | 'max' | undefined;
    const tokenAmount = metadata.token_amount ? parseInt(metadata.token_amount, 10) : 0;

    const billingProduct: BillingProduct = {
      id: price.id,
      stripeProductId: product.id,
      stripePriceId: price.id,
      productType: productType || 'subscription',
      subscriptionLevel: subscriptionLevel || null,
      tokenAmount,
      name: product.name,
      priceCents: price.unit_amount || 0,
      interval: price.recurring?.interval || null,
      active: price.active && product.active,
    };

    if (billingProduct.productType === 'subscription') {
      subscriptions.push(billingProduct);
    } else {
      packs.push(billingProduct);
    }
  }

  productsCache = { subscriptions, packs };
  productsCacheTime = Date.now();
  return productsCache;
}

async function getOrCreateCustomer(email: string): Promise<string> {
  const customers = await getStripe().customers.list({ email, limit: 1 });
  if (customers.data.length > 0) {
    return customers.data[0].id;
  }
  const customer = await getStripe().customers.create({ email });
  return customer.id;
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM public.users WHERE email = $1 LIMIT 1',
    [email]
  );
  return result.rows[0]?.id ?? null;
}

async function getTokenBalancesFromDb(userId: string): Promise<{ free: number; subscription: number; purchased: number; total: number }> {
  const result = await query<{ free_balance: number; subscription_balance: number; purchased_balance: number; total_balance: number }>(
    'SELECT * FROM public.get_token_balances($1)',
    [userId]
  );
  const row = result.rows[0];
  return {
    free: row?.free_balance ?? 0,
    subscription: row?.subscription_balance ?? 0,
    purchased: row?.purchased_balance ?? 0,
    total: row?.total_balance ?? 0,
  };
}

export const billing = {
  async getStatus(email: string): Promise<BillingStatus> {
    const customerId = await getOrCreateCustomer(email);
    const subscriptions = await getStripe().subscriptions.list({
      customer: customerId,
      status: 'all',
      expand: ['data.items.data.price'],
      limit: 1,
    });

    let subscriptionLevel: 'standard' | 'pro' | 'max' = 'standard';
    let subscriptionStatus: string | null = null;
    let currentPeriodEnd: string | null = null;

    if (subscriptions.data.length > 0) {
      const sub = subscriptions.data[0];
      subscriptionStatus = sub.status;
      currentPeriodEnd = new Date((sub as any).current_period_end * 1000).toISOString();

      const item = sub.items.data[0];
      const price = item.price as Stripe.Price;
      const productId = typeof price.product === 'string' ? price.product : price.product?.id;
      if (productId) {
        const product = await getStripe().products.retrieve(productId);
        const level = product.metadata?.subscription_level as string | undefined;
        if (level === 'standard' || level === 'pro' || level === 'max') {
          subscriptionLevel = level;
        }
      }
    }

    // Read real token balances from database
    const userId = await getUserIdByEmail(email);
    const tokens = userId
      ? await getTokenBalancesFromDb(userId)
      : { free: 50, subscription: 0, purchased: 0, total: 50 };

    return {
      user: { hasTrialed: false },
      subscription: subscriptions.data.length > 0 ? {
        level: subscriptionLevel,
        status: subscriptionStatus,
        currentPeriodEnd,
      } : null,
      tokens,
    };
  },

  async consume(email: string, body: { tokens: number; operation?: string; referenceId?: string }): Promise<ConsumeResult> {
    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return {
        ok: false,
        reason: 'insufficient_tokens',
        tokensRequired: body.tokens,
        tokensAvailable: 0,
        tokensDeducted: 0,
      };
    }

    const op = (body.operation as any) || 'mesh';
    const result = await query<{ result: any }>(
      'SELECT public.deduct_tokens($1, $2::public.token_operation_type, $3) as result',
      [userId, op, body.referenceId || null]
    );
    const data = result.rows[0]?.result;

    if (!data?.success) {
      return {
        ok: false,
        reason: 'insufficient_tokens',
        tokensRequired: body.tokens,
        tokensAvailable: data?.tokensAvailable ?? 0,
        tokensDeducted: 0,
      };
    }

    return {
      ok: true,
      tokensDeducted: data.tokensDeducted,
      freeBalance: data.freeBalance,
      subscriptionBalance: data.subscriptionBalance,
      purchasedBalance: data.purchasedBalance,
      totalBalance: data.totalBalance,
    };
  },

  async refund(email: string, body: { tokens: number; operation?: string; referenceId?: string }): Promise<RefundResult> {
    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return {
        ok: true,
        tokensRefunded: 0,
        source: 'subscription',
        freeBalance: 0,
        subscriptionBalance: 0,
        purchasedBalance: 0,
        totalBalance: 0,
      };
    }

    const op = (body.operation as any) || 'mesh';
    const result = await query<{ result: any }>(
      'SELECT public.refund_tokens($1, $2::public.token_operation_type, $3) as result',
      [userId, op, body.referenceId || null]
    );
    const data = result.rows[0]?.result;

    const balances = await getTokenBalancesFromDb(userId);

    return {
      ok: true,
      tokensRefunded: data?.tokensRefunded ?? body.tokens,
      source: data?.subscriptionBalance > balances.subscription ? 'subscription' : 'purchased',
      freeBalance: balances.free,
      subscriptionBalance: balances.subscription,
      purchasedBalance: balances.purchased,
      totalBalance: balances.total,
    };
  },

  async createCheckout(
    email: string,
    body: { priceId: string; successUrl: string; cancelUrl: string; trialPeriodDays?: number; mode?: 'subscription' | 'payment' },
  ): Promise<{ url: string }> {
    const customerId = await getOrCreateCustomer(email);
    const mode = body.mode || 'subscription';

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: body.priceId, quantity: 1 }],
      mode: mode as any,
      success_url: body.successUrl,
      cancel_url: body.cancelUrl,
      subscription_data: mode === 'subscription' && body.trialPeriodDays
        ? { trial_period_days: body.trialPeriodDays }
        : undefined,
    });

    if (!session.url) {
      throw new BillingClientError('checkout_session_missing_url', 502, null);
    }

    return { url: session.url };
  },

  async createPortal(email: string, body: { returnUrl: string }): Promise<{ url: string }> {
    const customerId = await getOrCreateCustomer(email);

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: body.returnUrl,
    });

    return { url: session.url };
  },

  async cancelSubscription(email: string, _body?: { feedback?: string; comment?: string }): Promise<CancelSubscriptionResult> {
    const customerId = await getOrCreateCustomer(email);
    const subscriptions = await getStripe().subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return { canceled: false, reason: 'no_subscription' };
    }

    await getStripe().subscriptions.cancel(subscriptions.data[0].id);
    return { canceled: true };
  },

  async getProductsByType(type: 'subscription' | 'pack'): Promise<BillingProduct[]> {
    const products = await getStripeProducts();
    return type === 'subscription' ? products.subscriptions : products.packs;
  },

  async getAllProducts(): Promise<{ subscriptions: BillingProduct[]; packs: BillingProduct[] }> {
    return getStripeProducts();
  },
};
