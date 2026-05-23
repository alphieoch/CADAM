import { createFileRoute } from '@tanstack/react-router';
import { billing, BillingClientError } from '@/server/stripeBilling';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';

export const Route = createFileRoute('/api/billing-cancel')({
  server: {
    handlers: {
      OPTIONS: preflight,
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const result = await billing.cancelSubscription(user.email!);
          return json(result);
        } catch (err) {
          const status = err instanceof BillingClientError ? err.status : 502;
          return json(
            {
              error: isUnauthorizedError(err)
                ? 'Unauthorized'
                : 'cancel_failed',
            },
            isUnauthorizedError(err) ? 401 : status,
          );
        }
      },
    },
  },
});
