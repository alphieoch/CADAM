import { createFileRoute } from '@tanstack/react-router';
import { query } from '@/server/dbClient';
import bcrypt from 'bcryptjs';

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const Route = createFileRoute('/api/auth/verify-reset')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}));
        const { token, password } = body;

        if (typeof token !== 'string' || typeof password !== 'string' || password.length < 6) {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const tokenHash = await hashToken(token);

        // Find valid token
        const tokenResult = await query<{ user_id: string }>(
          `SELECT user_id FROM public.password_reset_tokens
           WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL`,
          [tokenHash]
        );

        const tokenRecord = tokenResult.rows[0];
        if (!tokenRecord) {
          return new Response(JSON.stringify({ error: 'invalid_or_expired_token' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Update password
        const passwordHash = await bcrypt.hash(password, 12);
        await query(
          'UPDATE public.user_passwords SET password_hash = $1 WHERE user_id = $2',
          [passwordHash, tokenRecord.user_id]
        );

        // Mark token as used
        await query(
          'UPDATE public.password_reset_tokens SET used_at = now() WHERE token_hash = $1',
          [tokenHash]
        );

        // Clean up old tokens for this user
        await query(
          'DELETE FROM public.password_reset_tokens WHERE user_id = $1 AND used_at IS NOT NULL',
          [tokenRecord.user_id]
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});
