-- Recreate token tracking tables adapted for Azure-native auth (public.users FKs)
-- This replaces the dropped local billing schema with a working token economy

-- Types
CREATE TYPE IF NOT EXISTS "public"."token_operation_type" AS ENUM ('mesh', 'parametric', 'chat', 'refund', 'subscription_grant', 'pack_purchase');
CREATE TYPE IF NOT EXISTS "public"."token_source_type" AS ENUM ('free', 'subscription', 'purchased');

-- Token balances: one row per user per source
CREATE TABLE IF NOT EXISTS "public"."token_balances" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "source" public.token_source_type NOT NULL,
  "balance" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("user_id", "source")
);

-- Token costs per operation
CREATE TABLE IF NOT EXISTS "public"."token_costs" (
  "operation" public.token_operation_type NOT NULL,
  "cost" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("operation")
);

-- Token transactions audit log
CREATE TABLE IF NOT EXISTS "public"."token_transactions" (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "user_id" uuid NOT NULL,
  "operation" public.token_operation_type NOT NULL,
  "amount" integer NOT NULL,
  "source" public.token_source_type NOT NULL,
  "reference_id" text,
  "free_balance_after" integer NOT NULL DEFAULT 0,
  "subscription_balance_after" integer NOT NULL DEFAULT 0,
  "purchased_balance_after" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

-- Default costs (updated for new mesh tier pricing)
INSERT INTO "public"."token_costs" ("operation", "cost") VALUES
  ('mesh', 30),
  ('parametric', 5),
  ('chat', 1)
ON CONFLICT ("operation") DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "updated_at" = now();

-- Foreign keys to public.users (Azure-native auth)
ALTER TABLE "public"."token_balances"
  DROP CONSTRAINT IF EXISTS "token_balances_user_id_fkey",
  ADD CONSTRAINT "token_balances_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

ALTER TABLE "public"."token_transactions"
  DROP CONSTRAINT IF EXISTS "token_transactions_user_id_fkey",
  ADD CONSTRAINT "token_transactions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

-- Balance must be >= 0
ALTER TABLE "public"."token_balances"
  DROP CONSTRAINT IF EXISTS "token_balances_balance_check",
  ADD CONSTRAINT "token_balances_balance_check" CHECK ("balance" >= 0);

-- RLS
ALTER TABLE "public"."token_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."token_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."token_transactions" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "token_balances_read_own" ON "public"."token_balances";
CREATE POLICY "token_balances_read_own"
  ON "public"."token_balances"
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "token_costs_read" ON "public"."token_costs";
CREATE POLICY "token_costs_read"
  ON "public"."token_costs"
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "token_transactions_read_own" ON "public"."token_transactions";
CREATE POLICY "token_transactions_read_own"
  ON "public"."token_transactions"
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ============================================================
-- Functions
-- ============================================================

-- Just-in-time free tier reset: if free tokens expired, reset to 50
CREATE OR REPLACE FUNCTION public.reset_free_tier_jit(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_free_balance integer;
  v_free_expires timestamptz;
BEGIN
  SELECT balance, expires_at INTO v_free_balance, v_free_expires
  FROM public.token_balances
  WHERE user_id = p_user_id AND source = 'free';

  -- If no free row or expired, grant/reset 50 free tokens (24h expiry)
  IF v_free_balance IS NULL OR (v_free_expires IS NOT NULL AND v_free_expires < now()) THEN
    INSERT INTO public.token_balances (user_id, source, balance, expires_at)
    VALUES (p_user_id, 'free', 50, now() + interval '1 day')
    ON CONFLICT (user_id, source) DO UPDATE
    SET balance = 50, expires_at = now() + interval '1 day', updated_at = now();
  END IF;
END;
$function$;

-- Get current balances with JIT free reset
CREATE OR REPLACE FUNCTION public.get_token_balances(p_user_id uuid)
 RETURNS TABLE(free_balance integer, subscription_balance integer, purchased_balance integer, total_balance integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  PERFORM public.reset_free_tier_jit(p_user_id);

  RETURN QUERY
  SELECT
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now())), 0)::integer AS free_balance,
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription' AND (expires_at IS NULL OR expires_at > now())), 0)::integer AS subscription_balance,
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'purchased'), 0)::integer AS purchased_balance,
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now())), 0)::integer +
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription' AND (expires_at IS NULL OR expires_at > now())), 0)::integer +
    COALESCE((SELECT balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'purchased'), 0)::integer AS total_balance;
END;
$function$;

-- Deduct tokens: free first, then subscription, then purchased
CREATE OR REPLACE FUNCTION public.deduct_tokens(p_user_id uuid, p_operation public.token_operation_type, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_cost integer;
  v_free_balance integer;
  v_sub_balance integer;
  v_pur_balance integer;
  v_free_deduct integer;
  v_sub_deduct integer;
  v_pur_deduct integer;
BEGIN
  SELECT cost INTO v_cost FROM public.token_costs WHERE operation = p_operation;
  IF v_cost IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_operation');
  END IF;

  -- JIT reset free tier
  PERFORM public.reset_free_tier_jit(p_user_id);

  -- Get balances with row locks
  SELECT balance INTO v_free_balance
  FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now())
  FOR UPDATE;

  SELECT balance INTO v_sub_balance
  FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription' AND (expires_at IS NULL OR expires_at > now())
  FOR UPDATE;

  SELECT balance INTO v_pur_balance
  FROM public.token_balances WHERE user_id = p_user_id AND source = 'purchased'
  FOR UPDATE;

  v_free_balance := COALESCE(v_free_balance, 0);
  v_sub_balance := COALESCE(v_sub_balance, 0);
  v_pur_balance := COALESCE(v_pur_balance, 0);

  IF (v_free_balance + v_sub_balance + v_pur_balance) < v_cost THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_tokens',
      'tokensRequired', v_cost,
      'tokensAvailable', v_free_balance + v_sub_balance + v_pur_balance
    );
  END IF;

  -- Deduction order: free → subscription → purchased
  v_free_deduct := LEAST(v_cost, v_free_balance);
  v_sub_deduct := LEAST(v_cost - v_free_deduct, v_sub_balance);
  v_pur_deduct := v_cost - v_free_deduct - v_sub_deduct;

  IF v_free_deduct > 0 THEN
    UPDATE public.token_balances SET balance = balance - v_free_deduct, updated_at = now()
    WHERE user_id = p_user_id AND source = 'free';
  END IF;
  IF v_sub_deduct > 0 THEN
    UPDATE public.token_balances SET balance = balance - v_sub_deduct, updated_at = now()
    WHERE user_id = p_user_id AND source = 'subscription';
  END IF;
  IF v_pur_deduct > 0 THEN
    UPDATE public.token_balances SET balance = balance - v_pur_deduct, updated_at = now()
    WHERE user_id = p_user_id AND source = 'purchased';
  END IF;

  INSERT INTO public.token_transactions (
    user_id, operation, amount, source, reference_id,
    free_balance_after, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, p_operation, -v_cost,
    CASE
      WHEN v_free_deduct > 0 THEN 'free'::public.token_source_type
      WHEN v_sub_deduct > 0 THEN 'subscription'::public.token_source_type
      ELSE 'purchased'::public.token_source_type
    END,
    p_reference_id,
    v_free_balance - v_free_deduct,
    v_sub_balance - v_sub_deduct,
    v_pur_balance - v_pur_deduct
  );

  RETURN jsonb_build_object(
    'success', true,
    'tokensDeducted', v_cost,
    'freeBalance', v_free_balance - v_free_deduct,
    'subscriptionBalance', v_sub_balance - v_sub_deduct,
    'purchasedBalance', v_pur_balance - v_pur_deduct,
    'totalBalance', (v_free_balance - v_free_deduct) + (v_sub_balance - v_sub_deduct) + (v_pur_balance - v_pur_deduct)
  );
END;
$function$;

-- Refund tokens: restore to subscription up to grant limit, remainder to purchased
CREATE OR REPLACE FUNCTION public.refund_tokens(p_user_id uuid, p_operation public.token_operation_type, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_cost integer;
  v_free_balance integer;
  v_sub_balance integer;
  v_pur_balance integer;
  v_sub_limit integer;
  v_free_refund integer;
  v_sub_refund integer;
  v_pur_refund integer;
BEGIN
  SELECT cost INTO v_cost FROM public.token_costs WHERE operation = p_operation;
  IF v_cost IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_operation');
  END IF;

  SELECT balance INTO v_free_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE;
  SELECT balance INTO v_sub_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription' AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE;
  SELECT balance INTO v_pur_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'purchased' FOR UPDATE;

  v_free_balance := COALESCE(v_free_balance, 0);
  v_sub_balance := COALESCE(v_sub_balance, 0);
  v_pur_balance := COALESCE(v_pur_balance, 0);

  -- Refund order: subscription first (up to its limit), then purchased. Free is never refunded to.
  v_sub_limit := COALESCE((SELECT balance + v_cost FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription'), v_cost);
  v_sub_refund := LEAST(v_cost, GREATEST(v_sub_limit - v_sub_balance, 0));
  v_pur_refund := v_cost - v_sub_refund;

  IF v_sub_refund > 0 THEN
    UPDATE public.token_balances SET balance = balance + v_sub_refund, updated_at = now()
    WHERE user_id = p_user_id AND source = 'subscription';
  END IF;
  IF v_pur_refund > 0 THEN
    UPDATE public.token_balances SET balance = balance + v_pur_refund, updated_at = now()
    WHERE user_id = p_user_id AND source = 'purchased';
  END IF;

  INSERT INTO public.token_transactions (
    user_id, operation, amount, source, reference_id,
    free_balance_after, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, 'refund', v_cost,
    CASE WHEN v_sub_refund > 0 THEN 'subscription'::public.token_source_type ELSE 'purchased'::public.token_source_type END,
    p_reference_id,
    v_free_balance,
    v_sub_balance + v_sub_refund,
    v_pur_balance + v_pur_refund
  );

  RETURN jsonb_build_object(
    'success', true,
    'tokensRefunded', v_cost,
    'freeBalance', v_free_balance,
    'subscriptionBalance', v_sub_balance + v_sub_refund,
    'purchasedBalance', v_pur_balance + v_pur_refund
  );
END;
$function$;

-- Grant subscription tokens (overwrites subscription bucket, sets expiry)
CREATE OR REPLACE FUNCTION public.grant_subscription_tokens(p_user_id uuid, p_token_amount integer, p_expires_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_free_balance integer;
  v_pur_balance integer;
BEGIN
  INSERT INTO public.token_balances (user_id, source, balance, expires_at)
  VALUES (p_user_id, 'subscription', p_token_amount, p_expires_at)
  ON CONFLICT (user_id, source) DO UPDATE
  SET balance = p_token_amount, expires_at = p_expires_at, updated_at = now();

  SELECT COALESCE(balance, 0) INTO v_free_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now());
  SELECT COALESCE(balance, 0) INTO v_pur_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'purchased';

  INSERT INTO public.token_transactions (
    user_id, operation, amount, source, reference_id,
    free_balance_after, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, 'subscription_grant', p_token_amount, 'subscription', 'stripe_subscription',
    v_free_balance, p_token_amount, v_pur_balance
  );

  RETURN jsonb_build_object(
    'success', true,
    'tokensGranted', p_token_amount,
    'subscriptionBalance', p_token_amount,
    'expiresAt', p_expires_at
  );
END;
$function$;

-- Credit purchased tokens (adds to purchased bucket, never expires)
CREATE OR REPLACE FUNCTION public.credit_purchased_tokens(p_user_id uuid, p_amount integer, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_new_balance integer;
  v_free_balance integer;
  v_sub_balance integer;
BEGIN
  INSERT INTO public.token_balances (user_id, source, balance)
  VALUES (p_user_id, 'purchased', p_amount)
  ON CONFLICT (user_id, source) DO UPDATE
  SET balance = token_balances.balance + p_amount, updated_at = now()
  RETURNING balance INTO v_new_balance;

  SELECT COALESCE(balance, 0) INTO v_free_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'free' AND (expires_at IS NULL OR expires_at > now());
  SELECT COALESCE(balance, 0) INTO v_sub_balance FROM public.token_balances WHERE user_id = p_user_id AND source = 'subscription' AND (expires_at IS NULL OR expires_at > now());

  INSERT INTO public.token_transactions (
    user_id, operation, amount, source, reference_id,
    free_balance_after, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, 'pack_purchase', p_amount, 'purchased', p_reference_id,
    v_free_balance, v_sub_balance, v_new_balance
  );

  RETURN jsonb_build_object(
    'success', true,
    'tokensAdded', p_amount,
    'purchasedBalance', v_new_balance
  );
END;
$function$;

-- Trigger on public.users to initialize token balances for Azure-native auth
DROP TRIGGER IF EXISTS on_public_user_created ON public.users;
CREATE TRIGGER on_public_user_created
  AFTER INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Auto-refund on mesh failure
CREATE OR REPLACE FUNCTION public.handle_mesh_status_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF OLD.status != 'failure' AND NEW.status = 'failure' THEN
    PERFORM public.refund_tokens(NEW.user_id, 'mesh'::public.token_operation_type, NEW.id::text);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mesh_status_refund_trigger ON public.meshes;
CREATE TRIGGER mesh_status_refund_trigger
  AFTER UPDATE ON public.meshes
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_mesh_status_update();

-- Update handle_new_user to initialize token balances for new users
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      split_part(NEW.email, '@', 1)
    )
  );

  -- Initialize free tier: 50 tokens, 1-day expiry
  INSERT INTO public.token_balances (user_id, source, balance, expires_at)
  VALUES (NEW.id, 'free'::public.token_source_type, 50, now() + interval '1 day');

  -- Initialize purchased bucket at 0
  INSERT INTO public.token_balances (user_id, source, balance)
  VALUES (NEW.id, 'purchased'::public.token_source_type, 0);

  RETURN NEW;
END;
$function$;
