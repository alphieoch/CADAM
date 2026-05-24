import { createFileRoute } from '@tanstack/react-router';
import { json } from '@/server/api';
import Stripe from 'stripe';
import { env } from '@/server/env';
import { query } from '@/server/dbClient';

function getStripe(): Stripe {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, { apiVersion: '2026-04-22.dahlia' as any });
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM public.users WHERE email = $1 LIMIT 1',
    [email]
  );
  return result.rows[0]?.id ?? null;
}

async function getUserIdByStripeCustomer(customerId: string): Promise<string | null> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const email = (customer as Stripe.Customer).email;
  if (!email) return null;
  return getUserIdByEmail(email);
}

async function grantSubscriptionTokens(userId: string, tokenAmount: number, expiresAt: Date) {
  await query(
    'SELECT public.grant_subscription_tokens($1, $2, $3)',
    [userId, tokenAmount, expiresAt.toISOString()]
  );
}

async function creditPurchasedTokens(userId: string, tokenAmount: number, referenceId: string) {
  await query(
    'SELECT public.credit_purchased_tokens($1, $2, $3)',
    [userId, tokenAmount, referenceId]
  );
}

async function clearSubscriptionTokens(userId: string) {
  await query(
    "UPDATE public.token_balances SET balance = 0, updated_at = now() WHERE user_id = $1 AND source = 'subscription'",
    [userId]
  );
}

async function getProductTokenAmount(priceId: string): Promise<number> {
  const stripe = getStripe();
  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
  const product = price.product as Stripe.Product;
  const tokenAmount = product?.metadata?.token_amount;
  return tokenAmount ? parseInt(tokenAmount, 10) : 0;
}

export const Route = createFileRoute('/api/stripe-webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const webhookSecret = env('STRIPE_WEBHOOK_SECRET');
        if (!webhookSecret) {
          return json({ error: 'stripe_webhook_not_configured' }, 503);
        }
        const stripe = getStripe();

        const payload = await request.text();
        const signature = request.headers.get('stripe-signature');
        if (!signature) {
          return json({ error: 'missing_signature' }, 400);
        }

        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
        } catch (err) {
          console.error('Stripe webhook verification failed:', err);
          return json({ error: 'invalid_signature' }, 400);
        }

        console.log(`Stripe webhook received: ${event.type}`);

        try {
          switch (event.type) {
            case 'checkout.session.completed': {
              const session = event.data.object as Stripe.Checkout.Session;
              console.log('Checkout completed:', session.id, 'customer:', session.customer, 'mode:', session.mode);

              if (session.mode === 'subscription') {
                // Subscription checkout: grant subscription tokens
                const subscriptionId = session.subscription as string;
                if (!subscriptionId) break;

                const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
                  expand: ['items.data.price.product'],
                });

                const item = subscription.items.data[0];
                const price = item.price as Stripe.Price;
                const product = price.product as Stripe.Product;
                const tokenAmount = product?.metadata?.token_amount
                  ? parseInt(product.metadata.token_amount, 10)
                  : 0;
                const level = product?.metadata?.subscription_level as string || 'standard';

                // Default token amounts by level if metadata missing
                const defaultTokens: Record<string, number> = {
                  standard: 4_000,
                  pro: 10_000,
                  max: 50_000,
                };
                const grantAmount = tokenAmount || defaultTokens[level] || 4_000;
                const expiresAt = new Date((subscription as any).current_period_end * 1000);

                const userId = await getUserIdByStripeCustomer(session.customer as string);
                if (userId) {
                  await grantSubscriptionTokens(userId, grantAmount, expiresAt);
                  console.log(`Granted ${grantAmount} subscription tokens to user ${userId}, expires ${expiresAt.toISOString()}`);
                }
              } else if (session.mode === 'payment') {
                // One-time token pack purchase
                const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
                const priceId = lineItems.data[0]?.price?.id;
                if (!priceId) break;

                const tokenAmount = await getProductTokenAmount(priceId);
                if (tokenAmount > 0) {
                  const userId = await getUserIdByStripeCustomer(session.customer as string);
                  if (userId) {
                    await creditPurchasedTokens(userId, tokenAmount, session.id);
                    console.log(`Credited ${tokenAmount} purchased tokens to user ${userId}`);
                  }
                }
              }
              break;
            }

            case 'invoice.payment_succeeded': {
              const invoice = event.data.object as Stripe.Invoice;
              const invoiceSub = (invoice as any).subscription;
              console.log('Payment succeeded:', invoice.id, 'subscription:', invoiceSub);

              // Only handle subscription renewal invoices (not the first one from checkout)
              if (invoice.billing_reason === 'subscription_cycle' && invoiceSub) {
                const subscription = await stripe.subscriptions.retrieve(invoiceSub as string, {
                  expand: ['items.data.price.product'],
                });

                const item = subscription.items.data[0];
                const price = item.price as Stripe.Price;
                const product = price.product as Stripe.Product;
                const tokenAmount = product?.metadata?.token_amount
                  ? parseInt(product.metadata.token_amount, 10)
                  : 0;
                const level = product?.metadata?.subscription_level as string || 'standard';

                const defaultTokens: Record<string, number> = {
                  standard: 4_000,
                  pro: 10_000,
                  max: 50_000,
                };
                const grantAmount = tokenAmount || defaultTokens[level] || 4_000;
                const expiresAt = new Date((subscription as any).current_period_end * 1000);

                const userId = await getUserIdByStripeCustomer(invoice.customer as string);
                if (userId) {
                  await grantSubscriptionTokens(userId, grantAmount, expiresAt);
                  console.log(`Renewal: granted ${grantAmount} subscription tokens to user ${userId}, expires ${expiresAt.toISOString()}`);
                }
              }
              break;
            }

            case 'invoice.payment_failed': {
              const invoice = event.data.object as Stripe.Invoice;
              console.log('Payment failed:', invoice.id, 'customer:', invoice.customer);
              // Stripe handles retry logic. We don't revoke tokens immediately —
              // the subscription will enter past_due and eventually be canceled.
              break;
            }

            case 'customer.subscription.deleted': {
              const subscription = event.data.object as Stripe.Subscription;
              console.log('Subscription canceled/deleted:', subscription.id);

              const userId = await getUserIdByStripeCustomer(subscription.customer as string);
              if (userId) {
                await clearSubscriptionTokens(userId);
                console.log(`Cleared subscription tokens for user ${userId}`);
              }
              break;
            }

            default:
              console.log(`Unhandled Stripe event: ${event.type}`);
          }
        } catch (handlerError) {
          console.error('Stripe webhook handler error:', handlerError);
          // Still return 200 to Stripe so it doesn't retry endlessly
        }

        return json({ received: true });
      },
    },
  },
});
