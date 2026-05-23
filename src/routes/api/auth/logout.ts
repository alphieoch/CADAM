import { createFileRoute } from '@tanstack/react-router';
import { buildCookieHeader } from '@/server/auth';

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: async () => {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': buildCookieHeader('', true),
          },
        });
      },
    },
  },
});
