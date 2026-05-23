import { createClient } from '@supabase/supabase-js';
import { Database } from '@shared/database';

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawSupabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Flag used by the UI to show a helpful message instead of crashing
export const isSupabaseConfigMissing = !rawSupabaseUrl || !rawSupabaseKey;

// Fallback values keep the client constructable so imports don't throw
// when env vars are missing. The app should gate on isSupabaseConfigMissing
// and avoid making real requests in this state.
const supabaseUrl = rawSupabaseUrl || 'http://localhost';
const supabaseKey = rawSupabaseKey || 'public-anon-key';

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);

// Azure-native API client for when Supabase is not configured
export const azureApi = {
  async getUser() {
    const res = await fetch(`${import.meta.env.BASE_URL}/api/me`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    return res.json();
  },
  async signInWithMicrosoft() {
    window.location.href = `${import.meta.env.BASE_URL}/api/auth/microsoft`;
  },
};
