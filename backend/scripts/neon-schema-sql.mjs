export const neonSchemaSql = `
CREATE SCHEMA IF NOT EXISTS campaign_signal;

CREATE TABLE IF NOT EXISTS campaign_signal.organizations (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  organization_type TEXT NOT NULL DEFAULT 'Other',
  plan TEXT NOT NULL DEFAULT 'trial',
  status TEXT NOT NULL DEFAULT 'trialing',
  support_access_enabled INTEGER NOT NULL DEFAULT 0,
  billing_plan TEXT NOT NULL DEFAULT 'none',
  billing_status TEXT NOT NULL DEFAULT 'inactive',
  trial_status TEXT NOT NULL DEFAULT 'inactive',
  trial_started_at TEXT,
  trial_ends_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  report_limit INTEGER NOT NULL DEFAULT 0,
  reports_used INTEGER NOT NULL DEFAULT 0,
  user_limit INTEGER NOT NULL DEFAULT 1,
  workspace_limit INTEGER NOT NULL DEFAULT 1,
  subscription_current_period_start TEXT,
  subscription_current_period_end TEXT,
  subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  onboarding_paid_at TEXT,
  billing_updated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_signal.users (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  full_name TEXT,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, email)
);

CREATE TABLE IF NOT EXISTS campaign_signal.organization_users (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS campaign_signal.organization_invites (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by BIGINT NOT NULL,
  optional_message TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_signal.organization_audit_logs (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  actor_user_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  target_user_id BIGINT,
  target_email TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_signal.campaigns (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  race_name TEXT,
  office_type TEXT,
  location TEXT,
  election_date TEXT,
  incumbent TEXT,
  budget_band TEXT,
  objective TEXT,
  audience TEXT,
  context_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_signal.signal_reports (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  campaign_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence TEXT NOT NULL,
  key_signals_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  report_payload_json TEXT,
  intelligence_sources_json TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE campaign_signal.signal_reports
  ADD COLUMN IF NOT EXISTS report_payload_json TEXT;

CREATE TABLE IF NOT EXISTS campaign_signal.stripe_webhook_events (
  id BIGINT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_signal.subscriptions (
  id TEXT PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TEXT,
  created_at TEXT NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'campaign_signal'
      AND table_name = 'subscriptions'
      AND column_name = 'organization_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON campaign_signal.subscriptions(organization_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'campaign_signal'
      AND table_name = 'subscriptions'
      AND column_name = 'stripe_subscription_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON campaign_signal.subscriptions(stripe_subscription_id);
  END IF;
END
$$;

DO $$
BEGIN
  CREATE SEQUENCE IF NOT EXISTS campaign_signal.organizations_id_seq;
  ALTER TABLE campaign_signal.organizations ALTER COLUMN id SET DEFAULT nextval('campaign_signal.organizations_id_seq');
  PERFORM setval('campaign_signal.organizations_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.organizations), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.users_id_seq;
  ALTER TABLE campaign_signal.users ALTER COLUMN id SET DEFAULT nextval('campaign_signal.users_id_seq');
  PERFORM setval('campaign_signal.users_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.users), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.organization_users_id_seq;
  ALTER TABLE campaign_signal.organization_users ALTER COLUMN id SET DEFAULT nextval('campaign_signal.organization_users_id_seq');
  PERFORM setval('campaign_signal.organization_users_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.organization_users), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.organization_invites_id_seq;
  ALTER TABLE campaign_signal.organization_invites ALTER COLUMN id SET DEFAULT nextval('campaign_signal.organization_invites_id_seq');
  PERFORM setval('campaign_signal.organization_invites_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.organization_invites), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.organization_audit_logs_id_seq;
  ALTER TABLE campaign_signal.organization_audit_logs ALTER COLUMN id SET DEFAULT nextval('campaign_signal.organization_audit_logs_id_seq');
  PERFORM setval('campaign_signal.organization_audit_logs_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.organization_audit_logs), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.campaigns_id_seq;
  ALTER TABLE campaign_signal.campaigns ALTER COLUMN id SET DEFAULT nextval('campaign_signal.campaigns_id_seq');
  PERFORM setval('campaign_signal.campaigns_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.campaigns), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.signal_reports_id_seq;
  ALTER TABLE campaign_signal.signal_reports ALTER COLUMN id SET DEFAULT nextval('campaign_signal.signal_reports_id_seq');
  PERFORM setval('campaign_signal.signal_reports_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.signal_reports), 0) + 1, false);

  CREATE SEQUENCE IF NOT EXISTS campaign_signal.stripe_webhook_events_id_seq;
  ALTER TABLE campaign_signal.stripe_webhook_events ALTER COLUMN id SET DEFAULT nextval('campaign_signal.stripe_webhook_events_id_seq');
  PERFORM setval('campaign_signal.stripe_webhook_events_id_seq', COALESCE((SELECT MAX(id) FROM campaign_signal.stripe_webhook_events), 0) + 1, false);
END
$$;
`;
