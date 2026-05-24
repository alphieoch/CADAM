import { createFileRoute } from '@tanstack/react-router';
import { billing, BillingClientError } from '@/server/stripeBilling';
import { isRecord, json, methodNotAllowed, preflight } from '@/server/api';
import { requireUser } from '@/server/api';
import { query } from '@/server/dbClient';
import { getContainerClient } from '@/server/storageClient';

type CancellationFeedback =
  | 'customer_service'
  | 'low_quality'
  | 'missing_features'
  | 'other'
  | 'switched_service'
  | 'too_complex'
  | 'too_expensive'
  | 'unused';

function isCancellationFeedback(value: unknown): value is CancellationFeedback {
  switch (value) {
    case 'customer_service':
    case 'low_quality':
    case 'missing_features':
    case 'other':
    case 'switched_service':
    case 'too_complex':
    case 'too_expensive':
    case 'unused':
      return true;
    default:
      return false;
  }
}

export const Route = createFileRoute('/api/delete-user')({
  server: {
    handlers: {
      GET: methodNotAllowed,
      OPTIONS: preflight,
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const reason =
            isRecord(body) && isCancellationFeedback(body.reason)
              ? body.reason
              : undefined;

          // Cancel Stripe subscription if any
          try {
            const subscription = await billing.cancelSubscription(user.email, {
              feedback: reason,
            });
            if (!subscription.canceled) {
              console.log('No active subscription to cancel for user:', user.id);
            }
          } catch (subscriptionError) {
            if (subscriptionError instanceof BillingClientError) {
              console.error('Failed to cancel user subscription:', {
                status: subscriptionError.status,
                body: subscriptionError.body,
              });
            } else {
              console.error('Failed to cancel user subscription:', subscriptionError);
            }
          }

          // Delete user data from database (cascades via FKs)
          await query('DELETE FROM public.users WHERE id = $1', [user.id]);

          // Delete storage items in background
          runBackgroundTask(deleteUserStorageItems(user.id));

          return json({ success: true });
        } catch (err) {
          if (err instanceof Error && err.message === 'Unauthorized') {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Delete user error:', err);
          return json({ error: 'delete_failed' }, 500);
        }
      },
    },
  },
});

function runBackgroundTask(task: Promise<unknown>) {
  const loggedTask = task.catch((error) => {
    console.error('Background task failed:', error);
  });
  const requestContext = Reflect.get(
    globalThis,
    Symbol.for('@vercel/request-context'),
  );
  if (isRecord(requestContext) && typeof requestContext.get === 'function') {
    const context = requestContext.get();
    if (isRecord(context) && typeof context.waitUntil === 'function') {
      context.waitUntil(loggedTask);
      return;
    }
  }
  void loggedTask;
}

async function deleteUserStorageItems(userId: string): Promise<void> {
  for (const bucket of ['images', 'meshes', 'previews']) {
    try {
      const container = getContainerClient(bucket);
      const paths: string[] = [];
      for await (const blob of container.listBlobsFlat({ prefix: userId })) {
        paths.push(blob.name);
      }
      for (const path of paths) {
        await container.deleteBlob(path);
      }
    } catch (error) {
      console.error(`Failed to delete ${bucket} storage items:`, error);
    }
  }
}
