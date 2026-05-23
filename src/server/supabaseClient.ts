import {
  createClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js';
import type { Database } from '@shared/database';
import { env, requiredEnv } from './env';
import { getPool } from './dbClient';

export type SupabaseClient = ReturnType<typeof getAnonSupabaseClient>;

export function getAnonSupabaseClient(
  options?: SupabaseClientOptions<'public'>,
) {
  return createClient<Database, 'public', Database['public']>(
    requiredEnv('VITE_SUPABASE_URL'),
    requiredEnv('VITE_SUPABASE_ANON_KEY'),
    options,
  );
}

export function getServiceRoleSupabaseClient(
  options?: SupabaseClientOptions<'public'>,
) {
  return createClient<Database, 'public', Database['public']>(
    requiredEnv('VITE_SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      ...options,
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

// Azure-native mode check
export function isAzureNativeMode(): boolean {
  return !env('VITE_SUPABASE_URL') && !!env('DATABASE_URL');
}

// Get a database connection — returns Supabase client in legacy mode,
// or a PostgreSQL pool-compatible wrapper in Azure-native mode.
export function getDbClient() {
  if (isAzureNativeMode()) {
    return getPool();
  }
  return getAnonSupabaseClient();
}
