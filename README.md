# Campaign Signal Studio (Demo)

Working self-serve demo app built with React + TypeScript + Vite.

Now includes an Express + SQLite backend for a real SaaS foundation.

Includes OpenAI-backed report generation (with deterministic fallback).
Includes ElectionPredictor background intelligence from local snapshot data.

## Included now

- Landing page
- Signup/login placeholder flow
- Organization workspace
- Campaign profile form
- Signal report generator
- Saved reports in database
- Organization Console page
- Support access toggle placeholder
- Multi-tenant data model with organization_id scoping
- Pricing page
- Stripe checkout for subscription plans
- Team & Roles management
- Support/onboarding page
- Explicit trial vs subscription access states
- API-enforced limits (reports/month, users, campaign workspaces)

## Later-phase placeholders (not implemented yet)

- ElectionPredictor API connection
- Content calendar
- Consultant multi-client dashboard
- Support access toggle

## Team & Roles (v1)

Roles:

- owner
- admin
- manager
- contributor
- viewer

Implemented routes:

- `GET /api/team`
- `POST /api/team/invites`
- `POST /api/team/invites/:token/accept`
- `PATCH /api/team/members/:id/role`
- `DELETE /api/team/members/:id`
- `POST /api/team/invites/:id/resend`
- `POST /api/team/invites/:id/revoke`
- `DELETE /api/reports/:id`
- `DELETE /api/campaigns/:id`

Guardrails:

- Admin cannot remove or demote owner.
- Cannot remove/demote the only owner.
- Viewer cannot generate reports.
- Team routes are organization-scoped.
- Report delete requires `reports.delete` (owner/admin).
- Campaign delete requires `campaign.manage` (owner/admin/manager).

Database tables:

- `organization_users`
- `organization_invites`
- `organization_audit_logs`

Additional behavior:

- Pending invites are lazily expired on team reads and invite create checks.
- Workspace UI shows role label and permission hints for disabled actions.
- Audit logs are written for team role changes and member removals.

## Trial vs Subscription Access

New organizations start in a trial state.

- `billing_plan=trial`
- `billing_status=trialing`
- `trial_status=active`
- `trial_started_at` and `trial_ends_at` are set on signup.

Default trial profile:

- 7-day trial
- 1 campaign workspace
- 2 users max (owner + 1 teammate)
- 5 Signal Reports total
- saved reports enabled
- copy/download report text enabled in workspace UI

Premium features are gated by active trial or active subscription.

Gated endpoints include:

- Team and invite management routes
- Signal report generation route
- Support access toggle route

Plan/trial limits are enforced at API level:

- Trial total report limit or paid monthly report limit on `POST /api/reports/generate`
- User limit on team invites and invite acceptance
- Workspace limit on campaign creation

Note: In this version, `workspace_limit` is implemented as a limit on campaign workspaces (campaign records), not separate tenant containers.

`GET /api/organization` now includes access-state fields used by UI:

- `accessState` (`trial | active_subscription | inactive`)
- `hasPremiumAccess`
- `isSubscribed`
- `isTrialActive`
- `trialDaysRemaining`
- limit fields (`reportLimit`, `userLimit`, `workspaceLimit`)

## Authentication Storage

Passwords are now stored as bcrypt hashes.

- New signup and invite acceptance always hash passwords.
- Existing plaintext demo passwords are auto-migrated to bcrypt on successful login.

Optional env:

- `PASSWORD_HASH_ROUNDS` (default `12`)
- `TRIAL_DAYS` (default `7`)
- `TRIAL_REPORT_LIMIT` (default `5`)
- `TRIAL_USER_LIMIT` (default `2`)
- `TRIAL_WORKSPACE_LIMIT` (default `1`)

## Run locally

```bash
cd "C:\FelixPlatform\Campaign Signal Studio\app"
npm install
npm run dev
```

`npm run dev` now does all of this automatically:

- Kills stale process on port `4000`
- Starts backend in watch mode
- Starts frontend Vite server

Alternative commands:

- Backend only (watch): `npm run dev:server`
- Frontend only: `npm run dev:client`
- Backend only (no watch): `npm run start:server`

## OpenAI setup

1. Copy `.env.example` to `.env` in this folder.
2. Set `OPENAI_API_KEY` in `.env`.
3. (Optional) Set `OPENAI_REPORT_MODEL`.
4. Run backend with `npm run dev:server`.

By default, if OpenAI fails, backend falls back to deterministic generation.
Set `OPENAI_FALLBACK_TO_DETERMINISTIC=false` to force hard failure instead.

## ElectionPredictor intelligence

Campaign Signal Studio enriches prompts with local ElectionPredictor snapshot context from:

- `incoming/ElectionPredictor/ElectionPredictor/database/backups`

Environment options:

- `ELECTION_PREDICTOR_INTEL_ENABLED=true|false`
- `ELECTION_PREDICTOR_BACKUP_PATH=<absolute path>` (optional override)

## Stripe setup

1. Copy `.env.example` to `.env` in this folder if you have not already.
2. Open `.env` and add your Stripe keys.
3. Restart backend with `npm run dev:server`.

Required `.env` entries:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Optional but recommended (use recurring Stripe Price IDs from your dashboard):

```env
STRIPE_PRICE_STARTER_MONTHLY=price_...
STRIPE_PRICE_PROFESSIONAL_MONTHLY=price_...
STRIPE_PRICE_CONSULTANT_MONTHLY=price_...
STRIPE_PRICE_ONBOARDING_ONETIME=price_...
```

If price IDs are not set, the backend creates inline monthly prices matching the pricing page.

Recommended Stripe products and prices:

- Campaign Signal Studio - Starter: $99/month recurring
- Campaign Signal Studio - Professional: $299/month recurring
- Campaign Signal Studio - Consultant: $799/month recurring
- Campaign Signal Studio - Onboarding & Training: $750 one-time

Checkout metadata includes plan limits for downstream billing logic:

- starter: plan=starter, report_limit=25, workspace_limit=1, user_limit=5
- professional: plan=professional, report_limit=150, workspace_limit=0 (unlimited campaigns), user_limit=25
- consultant: plan=consultant, report_limit=500, workspace_limit=5, user_limit=50

### Stripe webhooks (required for auto-provisioning)

Webhook endpoint:

- `POST /api/billing/webhook`

Recommended events to subscribe:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Behavior:

- On successful subscription checkout, organization billing plan/status/limits are updated.
- On onboarding add-on payment, `onboarding_paid_at` is recorded.
- Subscription status changes and cancellations automatically update organization billing state.
- Webhook events are idempotent via `stripe_webhook_events` table.

## Build

```bash
cd "C:\FelixPlatform\Campaign Signal Studio\app"
npm run build
```

## Database

- SQLite database path: `backend/data/campaign-signal.db`
- Tables:
	- organizations
	- users
	- campaigns
	- signal_reports

All campaign and report queries are scoped by authenticated `organization_id`.

## Shared Neon Database

If you want a shared cloud database (instead of local-only SQLite), use Neon Postgres.

Runtime behavior:

- If `NEON_DATABASE_URL` (or `DATABASE_URL`) is set, backend uses Neon directly for runtime reads/writes.
- In production, Neon is the default runtime provider.
- You can explicitly set `DB_PROVIDER=neon` or `DB_PROVIDER=sqlite`.

1. Add your Neon connection string to `.env`:

```env
NEON_DATABASE_URL=postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=verify-full
# Optional libpq compatibility mode:
# NEON_DATABASE_URL=postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?uselibpqcompat=true&sslmode=require
```

Neon tables are created under the `campaign_signal` schema to avoid collisions with existing shared `public` tables.

2. Initialize Neon schema:

```bash
npm run db:neon:init
```

3. Sync current local SQLite data to Neon:

```bash
npm run db:neon:sync
```

4. Verify table counts in Neon:

```bash
npm run db:neon:verify
```

Neon runtime tables are in the `campaign_signal` schema.

Notes:

- This adds a shared Neon database path for collaboration/deploy environments.
- Existing local SQLite data can be seeded into Neon using the sync command above.

## Vercel Deployment Checklist (Neon Runtime)

Before promoting to production, confirm these in Vercel Project Settings -> Environment Variables:

1. `DB_PROVIDER=neon`
2. `NEON_DATABASE_URL=postgresql://...?...sslmode=verify-full`
3. `NODE_ENV=production`
4. Stripe env vars are present (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`)

Recommended pre-deploy verification:

1. `npm run db:neon:init`
2. `npm run db:neon:verify`

Post-deploy smoke test (API):

1. `GET /api/health` returns `{ "ok": true }`
2. `POST /api/auth/signup` creates a new org/user
3. `POST /api/auth/login` succeeds for that user
4. `GET /api/organization` (with auth headers) returns organization data and expected `accessState`
