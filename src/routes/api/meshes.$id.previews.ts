import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/meshes/$id/previews')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const result = await query(
            `SELECT id, user_id, conversation_id, mesh_id, status, created_at, updated_at
             FROM previews
             WHERE mesh_id = $1 AND user_id = $2 AND status = 'success'
             ORDER BY updated_at DESC
             LIMIT 1`,
            [params.id, user.id],
          );

          if (result.rows.length === 0) {
            return json({ error: 'preview_not_found' }, 404);
          }

          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Get preview error:', err);
          return json({ error: 'failed_to_load_preview' }, 502);
        }
      },
    },
  },
});
