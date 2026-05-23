import { createFileRoute } from '@tanstack/react-router';
import { getMicrosoftAuthUrl, generateOAuthState } from '@/server/auth';

export const Route = createFileRoute('/api/auth/microsoft')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        const redirectUri = `${baseUrl}/cadam/api/auth/microsoft/callback`;
        const state = generateOAuthState();
        const authUrl = getMicrosoftAuthUrl(state, redirectUri);

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl,
            'Set-Cookie': `oauth-state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
          },
        });
      },
    },
  },
});
