import { createFileRoute } from '@tanstack/react-router';
import { createToken, buildCookieHeader } from '@/server/auth';
import { query, withTransaction } from '@/server/dbClient';
import bcrypt from 'bcryptjs';

export const Route = createFileRoute('/api/auth/register')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}));
        const { email, password, name } = body;

        if (typeof email !== 'string' || typeof password !== 'string' || !email.includes('@') || password.length < 6) {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        try {
          const user = await withTransaction(async (client) => {
            const existing = await client.query('SELECT id FROM public.users WHERE email = $1', [email]);
            if (existing.rows.length > 0) {
              throw new Error('email_already_exists');
            }
            const userResult = await client.query<{
              id: string; email: string; full_name: string | null;
            }>(
              `INSERT INTO public.users (email, full_name, provider, last_sign_in_at)
               VALUES ($1, $2, 'email', now()) RETURNING id, email, full_name`,
              [email, typeof name === 'string' ? name : null]
            );
            const newUser = userResult.rows[0];
            await client.query(
              'INSERT INTO public.user_passwords (user_id, password_hash) VALUES ($1, $2)',
              [newUser.id, passwordHash]
            );
            return newUser;
          });

          const token = await createToken({
            id: user.id, email: user.email, full_name: user.full_name,
            avatar_url: null, provider: 'email',
          });

          return new Response(JSON.stringify({ user: { id: user.id, email: user.email, full_name: user.full_name, avatar_url: null, provider: 'email' } }), {
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': buildCookieHeader(token),
            },
          });
        } catch (err) {
          if (err instanceof Error && err.message === 'email_already_exists') {
            return new Response(JSON.stringify({ error: 'email_already_exists' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          console.error('Registration error:', err);
          return new Response(JSON.stringify({ error: 'registration_failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    },
  },
});
