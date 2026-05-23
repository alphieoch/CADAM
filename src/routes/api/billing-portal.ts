import { createFileRoute } from '@tanstack/react-router';
import { json, methodNotAllowed, preflight, requireUser } from '@/server/api';
import { billing } from '@/server/stripeBilling';
import { env } from '@/server/env';

const appUrl = () => env('ADAM_URL') || 'https://adam.new/app';

export const Route = createFileRoute('/api/billing-portal')({
  server: {
    handlers: {
      GET: methodNotAllowed,
      OPTIONS: preflight,
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          return json(
            await billing.createPortal(user.email!, { returnUrl: appUrl() }),
          );
        } catch (err) {
          return json(
            {
              error:
                err instanceof Error && err.message === 'Unauthorized'
                  ? 'Unauthorized'
                  : 'portal_failed',
            },
            err instanceof Error && err.message === 'Unauthorized' ? 401 : 502,
          );
        }
      },
    },
  },
});
