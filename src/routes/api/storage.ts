import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { getSignedUrl, uploadBlob, deleteBlob } from '@/server/storageClient';

export const Route = createFileRoute('/api/storage')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const url = new URL(request.url);
          const container = url.searchParams.get('container');
          const path = url.searchParams.get('path');

          if (!container || !path) {
            return json({ error: 'missing_params' }, 400);
          }

          // Security: ensure the path starts with the user's ID
          if (!path.startsWith(`${user.id}/`)) {
            return json({ error: 'unauthorized_path' }, 403);
          }

          const signedUrl = await getSignedUrl(container, path, 60);
          return json({ url: signedUrl });
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Storage signed URL error:', err);
          return json({ error: 'failed_to_generate_url' }, 502);
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const formData = await request.formData().catch(() => null);
          if (!formData) {
            return json({ error: 'invalid_form_data' }, 400);
          }

          const container = formData.get('container') as string;
          const path = formData.get('path') as string;
          const file = formData.get('file') as File | null;

          if (!container || !path || !file) {
            return json({ error: 'missing_fields' }, 400);
          }

          // Security: ensure the path starts with the user's ID
          if (!path.startsWith(`${user.id}/`)) {
            return json({ error: 'unauthorized_path' }, 403);
          }

          const buffer = Buffer.from(await file.arrayBuffer());
          const blobUrl = await uploadBlob(container, path, buffer, file.type);
          return json({ url: blobUrl });
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Storage upload error:', err);
          return json({ error: 'failed_to_upload' }, 502);
        }
      },
      DELETE: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const url = new URL(request.url);
          const container = url.searchParams.get('container');
          const path = url.searchParams.get('path');

          if (!container || !path) {
            return json({ error: 'missing_params' }, 400);
          }

          // Security: ensure the path starts with the user's ID
          if (!path.startsWith(`${user.id}/`)) {
            return json({ error: 'unauthorized_path' }, 403);
          }

          await deleteBlob(container, path);
          return json({ success: true });
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Storage delete error:', err);
          return json({ error: 'failed_to_delete' }, 502);
        }
      },
    },
  },
});
