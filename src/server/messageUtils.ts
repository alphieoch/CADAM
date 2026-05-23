import { env } from './env';

export function reformatSignedUrl(signedUrl: string): string {
  const supabaseHost =
    env('ENVIRONMENT') === 'local'
      ? env('NGROK_URL')
      : env('VITE_SUPABASE_URL');

  if (!supabaseHost) {
    // Azure-native mode: signed URLs are already complete SAS URLs
    return signedUrl;
  }

  const url = new URL(signedUrl);
  return `${supabaseHost.trim()}${url.pathname}${url.search}`;
}
