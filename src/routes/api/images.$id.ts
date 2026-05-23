import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/images/$id')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const result = await query(
            `SELECT id, user_id, conversation_id, prompt, status, image_generation_call_id, created_at
             FROM images
             WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );

          if (result.rows.length === 0) {
            return json({ error: 'image_not_found' }, 404);
          }

          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Get image error:', err);
          return json({ error: 'failed_to_load_image' }, 502);
        }
      },
    },
  },
});
