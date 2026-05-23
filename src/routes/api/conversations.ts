import { createFileRoute } from '@tanstack/react-router';
import { json, preflight, requireUser, isUnauthorizedError } from '@/server/api';
import { query, withTransaction } from '@/server/dbClient';
import type { Conversation } from '@shared/types';

export const Route = createFileRoute('/api/conversations')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const result = await query<Conversation>(
            `SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC`,
            [user.id],
          );
          return json(result.rows);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Load conversations error:', err);
          return json({ error: 'failed_to_load_conversations' }, 502);
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const { id, title, type, settings } = body;

          if (!id || !type) {
            return json({ error: 'invalid_request' }, 400);
          }

          const result = await query<Conversation>(
            `INSERT INTO conversations (id, user_id, title, type, settings)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [id, user.id, title || 'New Conversation', type, JSON.stringify(settings || {})],
          );

          return json(result.rows[0]);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            return json({ error: 'Unauthorized' }, 401);
          }
          console.error('Create conversation error:', err);
          return json({ error: 'failed_to_create_conversation' }, 502);
        }
      },
    },
  },
});
