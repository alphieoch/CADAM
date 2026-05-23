import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/conversations/$id/ensure-inputs')({
  server: {
    handlers: {
      OPTIONS: preflight,
      POST: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const { images, meshes } = body;

          // Verify conversation belongs to user
          const convResult = await query(
            `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );
          if (convResult.rows.length === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }

          // Upsert images
          if (Array.isArray(images) && images.length > 0) {
            for (const image of images) {
              await query(
                `INSERT INTO images (id, prompt, status, user_id, conversation_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO NOTHING`,
                [
                  image.id,
                  JSON.stringify(image.prompt || { text: 'User uploaded image' }),
                  image.status || 'success',
                  user.id,
                  params.id,
                ],
              );
            }
          }

          // Upsert meshes
          if (Array.isArray(meshes) && meshes.length > 0) {
            for (const mesh of meshes) {
              await query(
                `INSERT INTO meshes (id, conversation_id, user_id, status, prompt, file_type)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO NOTHING`,
                [
                  mesh.id,
                  params.id,
                  user.id,
                  mesh.status || 'success',
                  JSON.stringify(mesh.prompt || { text: 'User uploaded mesh' }),
                  mesh.file_type,
                ],
              );
            }
          }

          return json({ success: true });
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Ensure inputs error:', err);
          return json({ error: 'failed_to_ensure_inputs' }, 502);
        }
      },
    },
  },
});
