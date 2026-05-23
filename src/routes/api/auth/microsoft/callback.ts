import { createFileRoute } from '@tanstack/react-router';
import { createToken, buildCookieHeader, exchangeMicrosoftCode, fetchMicrosoftUser } from '@/server/auth';
import { query } from '@/server/dbClient';

export const Route = createFileRoute('/api/auth/microsoft/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const baseUrl = `${url.protocol}//${url.host}`;
        const redirectUri = `${baseUrl}/cadam/api/auth/microsoft/callback`;
        const appUrl = `${baseUrl}/cadam/`;

        if (error || !code) {
          return new Response(null, {
            status: 302,
            headers: { Location: `${appUrl}?error=oauth_failed` },
          });
        }

        try {
          const tokenData = await exchangeMicrosoftCode(code, redirectUri);
          const msUser = await fetchMicrosoftUser(tokenData.access_token);
          const email = msUser.mail || msUser.userPrincipalName;
          if (!email) throw new Error('No email from Microsoft');

          const userResult = await query<{
            id: string; email: string; full_name: string | null; avatar_url: string | null; provider: string;
          }>(
            'SELECT * FROM public.get_or_create_oauth_user($1, $2, $3, $4, $5, $6)',
            [email, 'microsoft', msUser.id, msUser.displayName, null,
             JSON.stringify({ givenName: msUser.givenName, surname: msUser.surname })]
          );

          const dbUser = userResult.rows[0];
          if (!dbUser) throw new Error('Failed to create or find user');

          const token = await createToken({
            id: dbUser.id, email: dbUser.email, full_name: dbUser.full_name,
            avatar_url: dbUser.avatar_url, provider: dbUser.provider,
          });

          return new Response(null, {
            status: 302,
            headers: {
              Location: appUrl,
              'Set-Cookie': buildCookieHeader(token),
            },
          });
        } catch (err) {
          console.error('Microsoft OAuth callback error:', err);
          return new Response(null, {
            status: 302,
            headers: { Location: `${appUrl}?error=oauth_callback_failed` },
          });
        }
      },
    },
  },
});
