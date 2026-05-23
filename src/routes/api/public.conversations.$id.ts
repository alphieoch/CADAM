import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/public/conversations/$id')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ params }) => {
        try {
          const result = await query(
            `SELECT id, user_id, title, type, settings, privacy, created_at, updated_at
             FROM conversations
             WHERE id = $1 AND privacy = 'public'`,
            [params.id],
          );

          if (result.rows.length === 0) {
            return json({ error: 'conversation_not_found_or_private' }, 404);
          }

          return json(result.rows[0]);
        } catch (err) {
          console.error('Get public conversation error:', err);
          return json({ error: 'failed_to_load_conversation' }, 502);
        }
      },
    },
  },
});
