import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/public/conversations/$id/messages')({
  server: {
    handlers: {
      OPTIONS: preflight,
      GET: async ({ params }) => {
        try {
          // First verify conversation exists and is public
          const convResult = await query(
            `SELECT id FROM conversations WHERE id = $1 AND privacy = 'public'`,
            [params.id],
          );

          if (convResult.rows.length === 0) {
            return json({ error: 'conversation_not_found_or_private' }, 404);
          }

          // Get messages
          const result = await query(
            `SELECT id, conversation_id, role, parts, reasoning_parts, created_at, updated_at
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [params.id],
          );

          return json(result.rows);
        } catch (err) {
          console.error('Get public messages error:', err);
          return json({ error: 'failed_to_load_messages' }, 502);
        }
      },
    },
  },
});
