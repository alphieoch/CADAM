import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';
import type { Message } from '@shared/types';

export const Route = createFileRoute('/api/conversations/$id/messages')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          // Verify conversation belongs to user
          const convResult = await query(
            `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );
          if (convResult.rows.length === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }

          const result = await query<Message>(
            `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [params.id],
          );
          return json(result.rows);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Load messages error:', err);
          return json({ error: 'failed_to_load_messages' }, 502);
        }
      },
      POST: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const { id, role, parts, metadata, parent_message_id } = body;

          if (!id || !role) {
            return json({ error: 'invalid_request' }, 400);
          }

          // Verify conversation belongs to user
          const convResult = await query(
            `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );
          if (convResult.rows.length === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }

          const result = await query<Message>(
            `INSERT INTO messages (id, conversation_id, role, parts, metadata, parent_message_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              id,
              params.id,
              role,
              JSON.stringify(parts || []),
              JSON.stringify(metadata || {}),
              parent_message_id || null,
            ],
          );

          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Create message error:', err);
          return json({ error: 'failed_to_create_message' }, 502);
        }
      },
    },
  },
});
