import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query } from '@/server/dbClient';
import type { Conversation } from '@shared/types';

export const Route = createFileRoute('/api/conversations/$id')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const result = await query<Conversation>(
            `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );
          if (result.rows.length === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }
          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Load conversation error:', err);
          return json({ error: 'failed_to_load_conversation' }, 502);
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const updates: string[] = [];
          const values: unknown[] = [];
          let paramIdx = 1;

          if (body.title !== undefined) {
            updates.push(`title = $${paramIdx++}`);
            values.push(body.title);
          }
          if (body.settings !== undefined) {
            updates.push(`settings = $${paramIdx++}`);
            values.push(JSON.stringify(body.settings));
          }
          if (body.current_message_leaf_id !== undefined) {
            updates.push(`current_message_leaf_id = $${paramIdx++}`);
            values.push(body.current_message_leaf_id);
          }

          if (updates.length === 0) {
            return json({ error: 'no_updates_provided' }, 400);
          }

          values.push(params.id, user.id);
          const result = await query<Conversation>(
            `UPDATE conversations SET ${updates.join(', ')}, updated_at = now()
             WHERE id = $${paramIdx++} AND user_id = $${paramIdx++}
             RETURNING *`,
            values,
          );

          if (result.rows.length === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }
          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Update conversation error:', err);
          return json({ error: 'failed_to_update_conversation' }, 502);
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const user = await requireUser(request);
          const result = await query(
            `DELETE FROM conversations WHERE id = $1 AND user_id = $2`,
            [params.id, user.id],
          );
          if (result.rowCount === 0) {
            return json({ error: 'conversation_not_found' }, 404);
          }
          return json({ success: true });
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Delete conversation error:', err);
          return json({ error: 'failed_to_delete_conversation' }, 502);
        }
      },
    },
  },
});
