-- Incremental auth migration: add missing columns and tables to existing users table

-- Add missing columns to users table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'full_name') THEN
    ALTER TABLE public.users ADD COLUMN full_name text;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_url') THEN
    ALTER TABLE public.users ADD COLUMN avatar_url text;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'provider') THEN
    ALTER TABLE public.users ADD COLUMN provider text NOT NULL DEFAULT 'email';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'provider_id') THEN
    ALTER TABLE public.users ADD COLUMN provider_id text;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_sign_in_at') THEN
    ALTER TABLE public.users ADD COLUMN last_sign_in_at timestamp with time zone;
  END IF;
END $$;

-- Rename azure_oid to provider_id if azure_oid exists and provider_id doesn't
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'azure_oid')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'provider_id') THEN
    ALTER TABLE public.users RENAME COLUMN azure_oid TO provider_id;
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'azure_oid')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'provider_id') THEN
    -- Copy data then drop
    UPDATE public.users SET provider_id = azure_oid WHERE provider_id IS NULL AND azure_oid IS NOT NULL;
    ALTER TABLE public.users DROP COLUMN azure_oid;
  END IF;
END $$;

-- Ensure provider is set correctly for existing users
UPDATE public.users SET provider = 'microsoft' WHERE provider_id IS NOT NULL AND provider = 'email';

-- Create password hashes table for email/password auth
CREATE TABLE IF NOT EXISTS public.user_passwords (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create sessions table for tracking active sessions
CREATE TABLE IF NOT EXISTS public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_jti text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  revoked_at timestamp with time zone
);

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

DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
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
