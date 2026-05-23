import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';
import type { Message } from '@shared/types';

export const Route = createFileRoute('/api/messages/$id')({
  server: {
    handlers: {
      OPTIONS: preflight,
      PATCH: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const updates: string[] = [];
          const values: unknown[] = [];
          let paramIdx = 1;

          if (body.parts !== undefined) {
            updates.push(`parts = $${paramIdx++}`);
            values.push(JSON.stringify(body.parts));
          }
          if (body.metadata !== undefined) {
            updates.push(`metadata = $${paramIdx++}`);
            values.push(JSON.stringify(body.metadata));
          }
          if (body.rating !== undefined) {
            updates.push(`rating = $${paramIdx++}`);
            values.push(body.rating);
          }
          if (body.parent_message_id !== undefined) {
            updates.push(`parent_message_id = $${paramIdx++}`);
            values.push(body.parent_message_id);
          }

          if (updates.length === 0) {
            return json({ error: 'no_updates_provided' }, 400);
          }

          values.push(params.id);
          const result = await query<Message>(
            `UPDATE messages SET ${updates.join(', ')}
             WHERE id = $${paramIdx++}
             AND EXISTS (
               SELECT 1 FROM conversations c
               WHERE c.id = messages.conversation_id AND c.user_id = $${paramIdx++}
             )
             RETURNING *`,
            [...values, user.id],
          );

          if (result.rows.length === 0) {
            return json({ error: 'message_not_found' }, 404);
          }
          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Update message error:', err);
          return json({ error: 'failed_to_update_message' }, 502);
        }
      },
    },
  },
});
