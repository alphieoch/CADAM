-- ============================================================================
-- CADAM Azure-Native PostgreSQL Schema
-- Replaces Supabase-specific features with standard PostgreSQL + Azure Auth
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. Users table (replaces auth.users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    email text UNIQUE NOT NULL,
    email_confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
    app_metadata jsonb DEFAULT '{}'::jsonb,
    azure_oid text UNIQUE
);

-- ============================================================================
-- 2. Enums
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation-type') THEN
        CREATE TYPE "public"."conversation-type" AS ENUM ('parametric', 'creative');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'generation-status') THEN
        CREATE TYPE "public"."generation-status" AS ENUM ('pending', 'success', 'failure');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mesh_file_type') THEN
        CREATE TYPE "public"."mesh_file_type" AS ENUM ('glb', 'stl', 'obj', 'fbx');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'privacy_type') THEN
        CREATE TYPE "public"."privacy_type" AS ENUM ('public', 'private');
    END IF;
END$$;

-- ============================================================================
-- 3. Profiles
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    full_name text,
    avatar_url text,
    notifications_enabled boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_id_idx ON public.profiles(user_id);

-- ============================================================================
-- 4. Conversations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.conversations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New Conversation',
    type "public"."conversation-type" DEFAULT 'parametric'::"public"."conversation-type" NOT NULL,
    privacy "public"."privacy_type" DEFAULT 'private'::"public"."privacy_type" NOT NULL,
    current_message_leaf_id uuid,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_created_at_idx ON public.conversations USING btree (created_at);
CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON public.conversations USING btree (updated_at);
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON public.conversations USING btree (user_id);

-- ============================================================================
-- 5. Messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text])),
    parts jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    content jsonb,
    rating smallint DEFAULT '0'::smallint NOT NULL,
    parent_message_id uuid,
    CONSTRAINT messages_payload_present CHECK ((jsonb_array_length(parts) > 0) OR (content IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON public.messages USING btree (conversation_id);

-- ============================================================================
-- 6. Meshes
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.meshes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status "public"."generation-status" DEFAULT 'pending'::"public"."generation-status" NOT NULL,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    images uuid[],
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    prompt jsonb DEFAULT '{}'::jsonb NOT NULL,
    file_type "public"."mesh_file_type" DEFAULT 'glb'::"public"."mesh_file_type" NOT NULL
);

-- ============================================================================
-- 7. Triggers
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_conversation_leaf()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.conversations
    SET current_message_leaf_id = NEW.id,
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_leaf_trigger ON public.messages;
CREATE TRIGGER update_leaf_trigger
    AFTER INSERT ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.update_conversation_leaf();

-- ============================================================================
-- 8. Helper function for conversation suggestions
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_conversation_suggestions(
    p_conversation_id uuid,
    p_suggestions jsonb
) RETURNS void LANGUAGE sql VOLATILE AS $$
    UPDATE public.conversations
    SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{suggestions}',
        p_suggestions,
        true
    )
    WHERE id = p_conversation_id;
$$;
