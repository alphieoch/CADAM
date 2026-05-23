import { createFileRoute } from '@tanstack/react-router';
import { verifyToken, payloadToUser } from '@/server/auth';

export const Route = createFileRoute('/api/auth/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cookie = request.headers.get('cookie');
        const match = cookie?.match(/cadam-session=([^;]+)/);
        const token = match ? decodeURIComponent(match[1]) : null;
        
        if (!token) {
          return new Response(JSON.stringify({ user: null }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const payload = await verifyToken(token);
        if (!payload) {
          return new Response(JSON.stringify({ user: null }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ user: payloadToUser(payload as Record<string, unknown>) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});
