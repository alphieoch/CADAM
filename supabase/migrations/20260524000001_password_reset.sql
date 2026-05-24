-- Password reset token storage for Azure-native auth

CREATE TABLE IF NOT EXISTS "public"."password_reset_tokens" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("token_hash")
);

ALTER TABLE "public"."password_reset_tokens"
  DROP CONSTRAINT IF EXISTS "password_reset_tokens_user_id_fkey",
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

-- Index for cleanup of expired tokens
CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_expires" ON "public"."password_reset_tokens"("expires_at");

-- RLS
ALTER TABLE "public"."password_reset_tokens" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_reset_tokens_service" ON "public"."password_reset_tokens";
CREATE POLICY "password_reset_tokens_service"
  ON "public"."password_reset_tokens"
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
