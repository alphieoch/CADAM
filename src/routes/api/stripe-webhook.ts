import { createFileRoute } from '@tanstack/react-router';
import { json } from '@/server/api';
import Stripe from 'stripe';
import { env } from '@/server/env';

function getStripe(): Stripe {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, { apiVersion: '2026-04-22.dahlia' as any });
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

        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            console.log('Checkout completed:', session.id, 'customer:', session.customer);
            // TODO: activate subscription, send welcome email, etc.
            break;
          }
          case 'invoice.payment_succeeded': {
            const invoice = event.data.object as Stripe.Invoice;
            console.log('Payment succeeded:', invoice.id, 'customer:', invoice.customer);
            // TODO: update subscription status, grant tokens, etc.
            break;
          }
          case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            console.log('Payment failed:', invoice.id, 'customer:', invoice.customer);
            // TODO: notify user, mark subscription past_due, etc.
            break;
          }
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            console.log('Subscription canceled:', subscription.id);
            // TODO: revoke subscription benefits
            break;
          }
          default:
            console.log(`Unhandled Stripe event: ${event.type}`);
        }

        return json({ received: true });
      },
    },
  },
});
