import { Resend } from 'resend';
import { env } from './env';

const resendApiKey = env('RESEND_API_KEY');
const fromEmail = env('FROM_EMAIL') || 'CADAM <noreply@cadam.app>';

let resend: Resend | null = null;

function getResend(): Resend | null {
  if (!resendApiKey) return null;
  if (!resend) resend = new Resend(resendApiKey);
  return resend;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<{ success: boolean; error?: string }> {
  const client = getResend();
  if (!client) {
    console.warn('RESEND_API_KEY not set, cannot send password reset email');
    return { success: false, error: 'email_service_not_configured' };
  }

  try {
    await client.emails.send({
      from: fromEmail,
      to,
      subject: 'Reset your CADAM password',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Password Reset</h2>
          <p>You requested a password reset for your CADAM account.</p>
          <p><a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a></p>
          <p style="color: #666; font-size: 14px;">This link expires in 1 hour. If you didn't request this, you can safely ignore it.</p>
        </div>
      `,
      text: `Reset your CADAM password: ${resetUrl}\n\nThis link expires in 1 hour.`,
    });
    return { success: true };
  } catch (err) {
    console.error('Failed to send password reset email:', err);
    return { success: false, error: 'email_send_failed' };
  }
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  const client = getResend();
  if (!client) return;

  try {
    await client.emails.send({
      from: fromEmail,
      to,
      subject: 'Welcome to CADAM',
      html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;"><h2>Welcome to CADAM!</h2><p>Your account is ready. Start creating 3D models with AI.</p></div>`,
    });
  } catch (err) {
    console.error('Failed to send welcome email:', err);
  }
}

export function isEmailConfigured(): boolean {
  return !!getResend();
}
