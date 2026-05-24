import { createFileRoute } from '@tanstack/react-router';
import { query } from '@/server/dbClient';
import { sendPasswordResetEmail, isEmailConfigured } from '@/server/email';
import { env } from '@/server/env';

// Simple hash function for tokens (not bcrypt since tokens are already random)
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const Route = createFileRoute('/api/auth/reset-password')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}));
        const { email } = body;

        if (typeof email !== 'string' || !email.includes('@')) {
          return new Response(JSON.stringify({ error: 'invalid_email' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Always return success to prevent email enumeration
        const userResult = await query<{ id: string; email: string }>(
          'SELECT id, email FROM public.users WHERE email = $1 AND provider = $2',
          [email.toLowerCase().trim(), 'email']
        );

        const user = userResult.rows[0];
        if (!user) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Generate reset token
        const rawToken = crypto.randomUUID() + crypto.randomUUID();
        const tokenHash = await hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Store hashed token
        await query(
          'INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
          [user.id, tokenHash, expiresAt.toISOString()]
        );

        // Send email if configured
        const baseUrl = env('ADAM_URL') || 'https://cadam-app-y4j7ueua3263k.thankfulrock-fe738ee3.uksouth.azurecontainerapps.io/cadam';
        const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;

        if (isEmailConfigured()) {
          const emailResult = await sendPasswordResetEmail(user.email, resetUrl);
          if (!emailResult.success) {
            console.error('Failed to send password reset email:', emailResult.error);
          }
        } else {
          console.log('Password reset URL (email not configured):', resetUrl);
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});
