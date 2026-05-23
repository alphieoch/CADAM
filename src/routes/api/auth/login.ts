import { createFileRoute } from '@tanstack/react-router';
import { createToken, buildCookieHeader } from '@/server/auth';
import { query } from '@/server/dbClient';
import bcrypt from 'bcryptjs';

export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;

        if (typeof email !== 'string' || typeof password !== 'string') {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const userResult = await query<{
          id: string; email: string; full_name: string | null; avatar_url: string | null;
        }>(
          'SELECT id, email, full_name, avatar_url FROM public.users WHERE email = $1 AND provider = $2',
          [email, 'email']
        );

        const user = userResult.rows[0];
        if (!user) {
          return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const pwResult = await query<{ password_hash: string }>(
          'SELECT password_hash FROM public.user_passwords WHERE user_id = $1',
          [user.id]
        );

        const pwRecord = pwResult.rows[0];
        if (!pwRecord || !(await bcrypt.compare(password, pwRecord.password_hash))) {
          return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        await query('UPDATE public.users SET last_sign_in_at = now() WHERE id = $1', [user.id]);

        const token = await createToken({
          id: user.id, email: user.email, full_name: user.full_name,
          avatar_url: user.avatar_url, provider: 'email',
        });

        return new Response(JSON.stringify({ user: { id: user.id, email: user.email, full_name: user.full_name, avatar_url: user.avatar_url, provider: 'email' } }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': buildCookieHeader(token),
          },
        });
      },
    },
  },
});
