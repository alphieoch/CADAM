import { createFileRoute } from '@tanstack/react-router';
import { billing, BillingClientError } from '@/server/stripeBilling';
import { isRecord, json, methodNotAllowed, preflight } from '@/server/api';
import {
  getServiceRoleSupabaseClient,
  type SupabaseClient,
} from '@/server/supabaseClient';

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
        const supabase = getServiceRoleSupabaseClient();
        const token = request.headers
          .get('Authorization')
          ?.replace('Bearer ', '');
        const body = await request.json().catch(() => ({}));
        const reason =
          isRecord(body) && isCancellationFeedback(body.reason)
            ? body.reason
            : undefined;
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data.user?.email)
          return json({ error: 'Unauthorized' }, 401);

        try {
          const subscription = await billing.cancelSubscription(
            data.user.email,
            { feedback: reason },
          );
          if (!subscription.canceled) {
            switch (subscription.reason) {
              case 'no_subscription':
              case 'already_canceled':
                break;
              default: {
                const unknownReason: never = subscription.reason;
                throw new Error(
                  `Unknown subscription cancellation reason: ${unknownReason}`,
                );
              }
            }
          }
        } catch (subscriptionError) {
          if (subscriptionError instanceof BillingClientError) {
            console.error('Failed to cancel user subscription:', {
              status: subscriptionError.status,
              body: subscriptionError.body,
            });
          } else {
            console.error(
              'Failed to cancel user subscription:',
              subscriptionError,
            );
          }
        }
        const { error: deleteError } = await supabase.auth.admin.deleteUser(
          data.user.id,
        );
        if (deleteError) return json({ error: 'Failed to delete user' }, 500);

        runBackgroundTask(deleteUserStorageItems(supabase, data.user.id));
        return json({ success: true });
      },
    },
  },
});

function runBackgroundTask(task: Promise<unknown>) {
  const loggedTask = task.catch((error) => {
    console.error('Failed to delete user storage items:', error);
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

async function deleteUserStorageItems(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  for (const bucket of ['images', 'meshes', 'previews']) {
    try {
      const paths = await listAllPaths(supabase, bucket, userId);
      for (let i = 0; i < paths.length; i += 1000) {
        const { error } = await supabase.storage
          .from(bucket)
          .remove(paths.slice(i, i + 1000));
        if (error) throw error;
      }
    } catch (error) {
      console.error(`Failed to delete ${bucket} storage items:`, error);
    }
  }
}

async function listAllPaths(
  supabase: SupabaseClient,
  bucket: string,
  folder: string,
): Promise<string[]> {
  const paths: string[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await supabase.storage.from(bucket).list(folder, {
      limit,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    if (!data.length) break;
    for (const item of data) {
      const path = `${folder}/${item.name}`;
      if ('id' in item && item.id) paths.push(path);
      else paths.push(...(await listAllPaths(supabase, bucket, path)));
    }
    if (data.length < limit) break;
  }
  return paths;
}
