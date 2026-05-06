-- Migration 0041: Subscription schema for P9 Phase 1 — Billing LIVE
--
-- Creates 7 new tables for the billing system:
--   subscription, subscription_item, onboarding_payment,
--   claimant_mobile_subscription, floor_topup_invoice,
--   founding_partner_slots, processed_webhook_events
--
-- Adds columns to existing tables:
--   tenant: tier, billing_mode, stripe_customer_id, trial_ends_at, trial_status
--   claim: delivery_kind, platform_fee_charged_at
--
-- founding_partner_slots is seeded with 10 rows (first-10 founding partner quota).
-- processed_webhook_events uses stripe_event_id as primary key for idempotency.
--
-- All tenant-scoped tables have RLS enabled with the canonical GUC policy.

-- ---------------------------------------------------------------------------
-- Extend tenant table
-- ---------------------------------------------------------------------------

ALTER TABLE "tenant"
  ADD COLUMN "tier" text NOT NULL DEFAULT 'standard'
    CONSTRAINT "tenant_tier_valid" CHECK (tier IN ('standard', 'founding_partner')),
  ADD COLUMN "billing_mode" text NOT NULL DEFAULT 'trial'
    CONSTRAINT "tenant_billing_mode_valid" CHECK (billing_mode IN ('trial', 'paid', 'archived')),
  ADD COLUMN "stripe_customer_id" text,
  ADD COLUMN "trial_ends_at" timestamp with time zone,
  ADD COLUMN "trial_status" text NOT NULL DEFAULT 'active'
    CONSTRAINT "tenant_trial_status_valid" CHECK (trial_status IN ('active', 'expired', 'converted'));

-- ---------------------------------------------------------------------------
-- Extend claim table
-- ---------------------------------------------------------------------------

ALTER TABLE "claim"
  ADD COLUMN "delivery_kind" text
    CONSTRAINT "claim_delivery_kind_valid" CHECK (
      delivery_kind IS NULL OR delivery_kind IN ('quarterly_assurance', 'annual_claim')
    ),
  ADD COLUMN "platform_fee_charged_at" timestamp with time zone;

-- ---------------------------------------------------------------------------
-- New table: subscription
-- Tracks the tenant's Stripe subscription (one per tenant at a time).
-- ---------------------------------------------------------------------------

CREATE TABLE "subscription" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "stripe_subscription_id" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'trialing'
    CONSTRAINT "subscription_status_valid" CHECK (
      status IN ('trialing', 'active', 'past_due', 'cancelled', 'incomplete')
    ),
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_tenant_isolation" ON "subscription"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

CREATE INDEX "subscription_tenant_id_idx" ON "subscription" ("tenant_id");

-- ---------------------------------------------------------------------------
-- New table: subscription_item
-- Individual line items on a Stripe subscription (per-claim, mobile, SLA, floor).
-- ---------------------------------------------------------------------------

CREATE TABLE "subscription_item" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "subscription_id" uuid NOT NULL REFERENCES "subscription" ("id"),
  "stripe_subscription_item_id" text NOT NULL UNIQUE,
  "price_kind" text NOT NULL
    CONSTRAINT "subscription_item_price_kind_valid" CHECK (
      price_kind IN ('per_claim', 'mobile', 'sla', 'floor_minimum')
    ),
  "quantity" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "subscription_item" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_item_tenant_isolation" ON "subscription_item"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

CREATE INDEX "subscription_item_tenant_id_idx" ON "subscription_item" ("tenant_id");
CREATE INDEX "subscription_item_subscription_id_idx" ON "subscription_item" ("subscription_id");

-- ---------------------------------------------------------------------------
-- New table: onboarding_payment
-- Records the one-time $5,000 AUD onboarding invoice.
-- ---------------------------------------------------------------------------

CREATE TABLE "onboarding_payment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL UNIQUE REFERENCES "tenant" ("id"),
  "stripe_invoice_id" text NOT NULL UNIQUE,
  "amount_aud_cents" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
    CONSTRAINT "onboarding_payment_status_valid" CHECK (
      status IN ('pending', 'paid', 'failed')
    ),
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "onboarding_payment" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "onboarding_payment_tenant_isolation" ON "onboarding_payment"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- New table: claimant_mobile_subscription
-- Tracks individual claimant mobile subscription intervals.
-- Quantity recomputed on change: paid_quantity = N - floor(N/3).
-- ---------------------------------------------------------------------------

CREATE TABLE "claimant_mobile_subscription" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "subject_tenant_id" uuid NOT NULL REFERENCES "subject_tenant" ("id"),
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "claimant_mobile_subscription" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claimant_mobile_subscription_tenant_isolation" ON "claimant_mobile_subscription"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

CREATE INDEX "claimant_mobile_sub_tenant_idx" ON "claimant_mobile_subscription" ("tenant_id");
CREATE INDEX "claimant_mobile_sub_subject_idx" ON "claimant_mobile_subscription" ("subject_tenant_id");

-- ---------------------------------------------------------------------------
-- New table: floor_topup_invoice
-- Monthly floor minimum top-up invoices when metered + SLA < $5,000/month.
-- ---------------------------------------------------------------------------

CREATE TABLE "floor_topup_invoice" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "stripe_invoice_id" text NOT NULL UNIQUE,
  "billing_month" text NOT NULL,
  "topup_amount_aud_cents" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
    CONSTRAINT "floor_topup_invoice_status_valid" CHECK (
      status IN ('pending', 'paid', 'failed')
    ),
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "floor_topup_invoice" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "floor_topup_invoice_tenant_isolation" ON "floor_topup_invoice"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

CREATE INDEX "floor_topup_invoice_tenant_idx" ON "floor_topup_invoice" ("tenant_id");

-- ---------------------------------------------------------------------------
-- New table: founding_partner_slots
-- First 10 rows represent available founding partner slots (seeded).
-- Claiming a slot (race-safe):
--   UPDATE SET claimed_by_tenant_id = <id> WHERE id = (
--     SELECT id FROM founding_partner_slots
--     WHERE claimed_by_tenant_id IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED
--   ) RETURNING id
-- No RLS — global allocation table (no tenant scope).
-- ---------------------------------------------------------------------------

CREATE TABLE "founding_partner_slots" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "claimed_by_tenant_id" uuid REFERENCES "tenant" ("id"),
  "claimed_at" timestamp with time zone
);

-- Seed 10 available slots
INSERT INTO "founding_partner_slots" ("id")
VALUES
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid()),
  (gen_random_uuid());

-- ---------------------------------------------------------------------------
-- New table: processed_webhook_events
-- Idempotency table for Stripe webhook event processing.
-- stripe_event_id is the PRIMARY KEY — INSERT ON CONFLICT DO NOTHING.
-- No RLS — system table, not tenant-scoped.
-- ---------------------------------------------------------------------------

CREATE TABLE "processed_webhook_events" (
  "stripe_event_id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "processed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "tenant_id" uuid REFERENCES "tenant" ("id")
);

CREATE INDEX "processed_webhook_events_tenant_idx" ON "processed_webhook_events" ("tenant_id");
