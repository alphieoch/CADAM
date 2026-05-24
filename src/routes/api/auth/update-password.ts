import { createFileRoute } from '@tanstack/react-router';
import { query } from '@/server/dbClient';
import { requireUser } from '@/server/api';
import bcrypt from 'bcryptjs';

export const Route = createFileRoute('/api/auth/update-password')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const user = await requireUser(request);
          const body = await request.json().catch(() => ({}));
          const { currentPassword, newPassword } = body;

          if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 6) {
            return new Response(JSON.stringify({ error: 'invalid_request' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Verify current password
          const pwResult = await query<{ password_hash: string }>(
            'SELECT password_hash FROM public.user_passwords WHERE user_id = $1',
            [user.id]
          );

          const pwRecord = pwResult.rows[0];
          if (!pwRecord || !(await bcrypt.compare(currentPassword, pwRecord.password_hash))) {
            return new Response(JSON.stringify({ error: 'invalid_current_password' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Update password
          const newHash = await bcrypt.hash(newPassword, 12);
          await query(
            'UPDATE public.user_passwords SET password_hash = $1 WHERE user_id = $2',
            [newHash, user.id]
          );

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          if (err instanceof Error && err.message === 'Unauthorized') {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          console.error('Update password error:', err);
          return new Response(JSON.stringify({ error: 'update_failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    },
  },
});
