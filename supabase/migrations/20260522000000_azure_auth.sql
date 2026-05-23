-- Azure-native auth tables (replaces Supabase auth.users)
-- Run this after migrating from Supabase to Azure PostgreSQL

-- Users table to replace auth.users
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  full_name text,
  avatar_url text,
  provider text NOT NULL DEFAULT 'email', -- 'email', 'microsoft', 'google'
  provider_id text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_sign_in_at timestamp with time zone,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb
);

-- Password hashes for email/password auth
CREATE TABLE IF NOT EXISTS public.user_passwords (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Sessions table for tracking active sessions (optional, for revocation)
CREATE TABLE IF NOT EXISTS public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_jti text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  revoked_at timestamp with time zone
);

-- Update existing foreign keys from auth.users to public.users
-- Note: Run this only after data migration
-- ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_user_id_fkey;
-- ALTER TABLE public.conversations ADD CONSTRAINT conversations_user_id_fkey 
--   FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- For now, keep conversations without FK to allow orphaned data during transition
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_user_id_fkey;

-- Same for other tables referencing auth.users
ALTER TABLE public.images DROP CONSTRAINT IF EXISTS images_user_id_fkey;
ALTER TABLE public.meshes DROP CONSTRAINT IF EXISTS meshes_user_id_fkey;

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_provider ON public.users(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON public.user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_jti ON public.user_sessions(token_jti);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create a function to get or create user from OAuth (idempotent)
CREATE OR REPLACE FUNCTION public.get_or_create_oauth_user(
  p_email text,
  p_provider text,
  p_provider_id text,
  p_full_name text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_raw_user_meta_data jsonb DEFAULT '{}'::jsonb
)
RETURNS public.users AS $$
DECLARE
  v_user public.users;
BEGIN
  -- Try to find existing user by provider + provider_id
  SELECT * INTO v_user FROM public.users 
  WHERE provider = p_provider AND provider_id = p_provider_id;
  
  IF FOUND THEN
    -- Update last sign in
    UPDATE public.users 
    SET last_sign_in_at = now(),
        email = p_email,
        full_name = COALESCE(p_full_name, full_name),
        avatar_url = COALESCE(p_avatar_url, avatar_url),
        raw_user_meta_data = p_raw_user_meta_data
    WHERE id = v_user.id
    RETURNING * INTO v_user;
    RETURN v_user;
  END IF;
  
  -- Try to find by email
  SELECT * INTO v_user FROM public.users WHERE email = p_email;
  
  IF FOUND THEN
    -- Link OAuth to existing email account
    UPDATE public.users 
    SET provider = p_provider,
        provider_id = p_provider_id,
        last_sign_in_at = now(),
        full_name = COALESCE(p_full_name, full_name),
        avatar_url = COALESCE(p_avatar_url, avatar_url),
        raw_user_meta_data = p_raw_user_meta_data
    WHERE id = v_user.id
    RETURNING * INTO v_user;
    RETURN v_user;
  END IF;
  
  -- Create new user
  INSERT INTO public.users (email, full_name, avatar_url, provider, provider_id, last_sign_in_at, raw_user_meta_data)
  VALUES (p_email, p_full_name, p_avatar_url, p_provider, p_provider_id, now(), p_raw_user_meta_data)
  RETURNING * INTO v_user;
  
  RETURN v_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
