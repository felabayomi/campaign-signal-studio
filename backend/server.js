import "dotenv/config";
import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import db, { nowIso } from "./db.js";
import { generateCampaignSignalReport } from "./services/reportGenerator.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

const stripePlanConfig = {
    starter: {
        label: "Starter",
        amount: 9900,
        mode: "subscription",
        priceEnv: "STRIPE_PRICE_STARTER_MONTHLY",
        reportLimit: 25,
        workspaceLimit: 1,
        userLimit: 5,
    },
    professional: {
        label: "Professional",
        amount: 29900,
        mode: "subscription",
        priceEnv: "STRIPE_PRICE_PROFESSIONAL_MONTHLY",
        reportLimit: 150,
        workspaceLimit: 0,
        userLimit: 25,
    },
    consultant: {
        label: "Consultant",
        amount: 79900,
        mode: "subscription",
        priceEnv: "STRIPE_PRICE_CONSULTANT_MONTHLY",
        reportLimit: 500,
        workspaceLimit: 5,
        userLimit: 50,
    },
    onboarding_training: {
        label: "Onboarding & Training",
        amount: 75000,
        mode: "payment",
        priceEnv: "STRIPE_PRICE_ONBOARDING_ONETIME",
        reportLimit: 0,
        workspaceLimit: 0,
        userLimit: 0,
    },
};

const validRoles = new Set(["owner", "admin", "manager", "contributor", "viewer"]);
const validOrganizationTypes = new Set(["Campaign", "PAC", "Consultant", "Advocacy Group", "Other"]);
const trialConfig = {
    days: Number(process.env.TRIAL_DAYS || 7),
    reportLimit: Number(process.env.TRIAL_REPORT_LIMIT || 5),
    workspaceLimit: Number(process.env.TRIAL_WORKSPACE_LIMIT || 1),
    userLimit: Number(process.env.TRIAL_USER_LIMIT || 2),
};
const passwordHashRounds = Number(process.env.PASSWORD_HASH_ROUNDS || 12);

const rolePermissions = {
    owner: [
        "billing.manage",
        "team.manage",
        "team.view",
        "campaign.manage",
        "campaign.view",
        "reports.generate",
        "reports.view",
        "reports.delete",
        "support.enable",
        "usage.view",
    ],
    admin: [
        "team.manage",
        "team.view",
        "campaign.manage",
        "campaign.view",
        "reports.generate",
        "reports.view",
        "reports.delete",
        "support.enable",
        "usage.view",
    ],
    manager: [
        "team.view",
        "campaign.manage",
        "campaign.view",
        "reports.generate",
        "reports.view",
        "usage.view",
    ],
    contributor: [
        "reports.generate",
        "reports.view",
        "campaign.view",
    ],
    viewer: [
        "reports.view",
        "campaign.view",
    ],
};

app.use(cors({ origin: true, credentials: true }));

function toIsoFromUnix(unixSeconds) {
    if (!unixSeconds) return null;
    const millis = Number(unixSeconds) * 1000;
    if (!Number.isFinite(millis)) return null;
    return new Date(millis).toISOString();
}

function addDaysToIso(baseIso, days) {
    const base = baseIso ? new Date(baseIso) : new Date();
    const millis = base.getTime() + days * 24 * 60 * 60 * 1000;
    return new Date(millis).toISOString();
}

function monthStartIso() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

async function getOrganizationRecord(organizationId) {
    return db.get("SELECT * FROM organizations WHERE id = ?", organizationId);
}

async function activeMemberCount(organizationId) {
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM organization_users
         WHERE organization_id = ? AND status = 'active'`,
        organizationId
    );
    return Number(row?.count || 0);
}

async function pendingInviteCount(organizationId) {
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM organization_invites
         WHERE organization_id = ? AND status = 'pending'`,
        organizationId
    );
    return Number(row?.count || 0);
}

async function campaignWorkspaceCount(organizationId) {
    const row = await db.get("SELECT COUNT(*) AS count FROM campaigns WHERE organization_id = ?", organizationId);
    return Number(row?.count || 0);
}

async function monthlyReportCount(organizationId) {
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM signal_reports
         WHERE organization_id = ? AND created_at >= ?`,
        organizationId,
        monthStartIso()
    );
    return Number(row?.count || 0);
}

async function totalReportCount(organizationId) {
    const row = await db.get("SELECT COUNT(*) AS count FROM signal_reports WHERE organization_id = ?", organizationId);
    return Number(row?.count || 0);
}

async function trialGeneratedReportCount(organizationId) {
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM organization_audit_logs
         WHERE organization_id = ? AND action = 'report.generated'`,
        organizationId
    );
    return Number(row?.count || 0);
}

function isSubscriptionActive(status) {
    return ["active", "trialing", "past_due"].includes(String(status || "").toLowerCase());
}

function resolveOrganizationStatus(org) {
    return String(org?.status || org?.billing_status || "inactive").toLowerCase();
}

function resolveOrganizationPlan(org) {
    return String(org?.plan || org?.billing_plan || "trial").toLowerCase();
}

function canGenerateReport(orgView) {
    if (orgView.status === "trialing") {
        return orgView.reportsUsed < 5 && Date.now() < new Date(orgView.trialEndsAt || 0).getTime();
    }

    if (orgView.status === "active") {
        return orgView.reportsUsed < orgView.reportLimit;
    }

    return false;
}

async function getOrganizationEntitlements(organizationId) {
    let org = await getOrganizationRecord(organizationId);
    if (!org) return null;

    const now = Date.now();
    const trialEndMs = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : NaN;
    const orgStatus = resolveOrganizationStatus(org);
    const orgPlan = resolveOrganizationPlan(org);
    const trialExpired = (org.trial_status === "active" || orgStatus === "trialing")
        && Number.isFinite(trialEndMs)
        && trialEndMs < now;

    if (trialExpired) {
        const shouldDisableBilling = !isSubscriptionActive(orgStatus)
            || orgPlan === "none"
            || orgPlan === "trial";

        await db.run(
            `UPDATE organizations
             SET trial_status = 'expired',
                 plan = CASE WHEN ? THEN 'none' ELSE plan END,
                 status = CASE WHEN ? THEN 'inactive' ELSE status END,
                 billing_plan = CASE WHEN ? THEN 'none' ELSE billing_plan END,
                 billing_status = CASE WHEN ? THEN 'inactive' ELSE billing_status END,
                 report_limit = CASE WHEN ? THEN 0 ELSE report_limit END,
                 user_limit = CASE WHEN ? THEN 1 ELSE user_limit END,
                 workspace_limit = CASE WHEN ? THEN 1 ELSE workspace_limit END,
                 billing_updated_at = ?
             WHERE id = ?`,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            shouldDisableBilling ? 1 : 0,
            nowIso(),
            organizationId
        );

        org = await getOrganizationRecord(organizationId);
    }

    const finalStatus = resolveOrganizationStatus(org);
    const finalPlan = resolveOrganizationPlan(org);
    const isSubscribed = finalPlan !== "none"
        && finalPlan !== "trial"
        && isSubscriptionActive(finalStatus);
    const isTrialActive = org.trial_status === "active" || finalStatus === "trialing";
    const hasPremiumAccess = isSubscribed || isTrialActive;
    const trialDaysRemaining = isTrialActive && org.trial_ends_at
        ? Math.max(0, Math.ceil((new Date(org.trial_ends_at).getTime() - now) / (24 * 60 * 60 * 1000)))
        : 0;

    return {
        org,
        isSubscribed,
        isTrialActive,
        hasPremiumAccess,
        trialDaysRemaining,
        accessState: isSubscribed ? "active_subscription" : isTrialActive ? "trial" : "inactive",
        reportLimitWindow: isTrialActive ? "total" : "monthly",
        reportLimit: Number(org.report_limit || 0),
        userLimit: Number(org.user_limit || 1),
        workspaceLimit: Number(org.workspace_limit || 1),
    };
}

async function upsertSubscriptionRecord({ organizationId, stripeCustomerId, stripeSubscriptionId, plan, status, currentPeriodEnd }) {
    const id = stripeSubscriptionId || `org-${organizationId}-${Date.now()}`;
    await db.run(
        `INSERT INTO subscriptions (id, organization_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            organization_id = excluded.organization_id,
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            plan = excluded.plan,
            status = excluded.status,
            current_period_end = excluded.current_period_end`,
        id,
        organizationId,
        stripeCustomerId || null,
        stripeSubscriptionId || null,
        plan || "trial",
        status || "trialing",
        currentPeriodEnd || null,
        nowIso()
    );
}

function resolvePlanFromPriceId(priceId) {
    if (!priceId) return null;

    const priceToPlan = {
        [process.env.STRIPE_PRICE_STARTER_MONTHLY || ""]: "starter",
        [process.env.STRIPE_PRICE_PROFESSIONAL_MONTHLY || ""]: "professional",
        [process.env.STRIPE_PRICE_CONSULTANT_MONTHLY || ""]: "consultant",
        [process.env.STRIPE_PRICE_ONBOARDING_ONETIME || ""]: "onboarding_training",
    };

    return priceToPlan[priceId] || null;
}

async function findOrganizationForStripeEvent({ organizationId, subscriptionId, customerId }) {
    if (organizationId) {
        const byId = await db.get("SELECT id FROM organizations WHERE id = ?", Number(organizationId));
        if (byId) return byId.id;
    }

    if (subscriptionId) {
        const bySubscription = await db.get(
            "SELECT id FROM organizations WHERE stripe_subscription_id = ?",
            String(subscriptionId)
        );
        if (bySubscription) return bySubscription.id;
    }

    if (customerId) {
        const byCustomer = await db.get("SELECT id FROM organizations WHERE stripe_customer_id = ?", String(customerId));
        if (byCustomer) return byCustomer.id;
    }

    return null;
}

async function updateOrganizationBillingState(orgId, patch) {
    const current = await db.get("SELECT * FROM organizations WHERE id = ?", orgId);

    if (!current) return;

    await db.run(
        `UPDATE organizations
         SET billing_plan = ?, billing_status = ?, trial_status = ?, trial_started_at = ?, trial_ends_at = ?,
             plan = ?, status = ?,
             stripe_customer_id = ?, stripe_subscription_id = ?,
             report_limit = ?, reports_used = ?, user_limit = ?, workspace_limit = ?,
             subscription_current_period_start = ?, subscription_current_period_end = ?,
             subscription_cancel_at_period_end = ?, onboarding_paid_at = ?, billing_updated_at = ?
         WHERE id = ?`,
        patch.billingPlan ?? current.billing_plan,
        patch.billingStatus ?? current.billing_status,
        patch.trialStatus ?? current.trial_status,
        patch.trialStartedAt ?? current.trial_started_at,
        patch.trialEndsAt ?? current.trial_ends_at,
        patch.plan ?? current.plan,
        patch.status ?? current.status,
        patch.stripeCustomerId ?? current.stripe_customer_id,
        patch.stripeSubscriptionId ?? current.stripe_subscription_id,
        patch.reportLimit ?? current.report_limit,
        patch.reportsUsed ?? current.reports_used,
        patch.userLimit ?? current.user_limit,
        patch.workspaceLimit ?? current.workspace_limit,
        patch.subscriptionCurrentPeriodStart ?? current.subscription_current_period_start,
        patch.subscriptionCurrentPeriodEnd ?? current.subscription_current_period_end,
        patch.subscriptionCancelAtPeriodEnd ?? current.subscription_cancel_at_period_end,
        patch.onboardingPaidAt ?? current.onboarding_paid_at,
        nowIso(),
        orgId
    );
}

async function markOnboardingPaid(orgId, customerId) {
    await updateOrganizationBillingState(orgId, {
        stripeCustomerId: customerId || null,
        onboardingPaidAt: nowIso(),
    });
}

async function applySubscriptionState(orgId, subscription) {
    const item = subscription.items?.data?.[0] || null;
    const priceId = item?.price?.id || null;
    const metadataPlan = subscription.metadata?.plan || null;
    const resolvedPlan = metadataPlan || resolvePlanFromPriceId(priceId);
    const config = resolvedPlan ? stripePlanConfig[resolvedPlan] : null;

    await updateOrganizationBillingState(orgId, {
        billingPlan: resolvedPlan && resolvedPlan !== "onboarding_training" ? resolvedPlan : undefined,
        billingStatus: subscription.status || "active",
        plan: resolvedPlan && resolvedPlan !== "onboarding_training" ? resolvedPlan : undefined,
        status: subscription.status || "active",
        trialStatus: "converted",
        stripeCustomerId: subscription.customer ? String(subscription.customer) : undefined,
        stripeSubscriptionId: subscription.id,
        reportLimit: config && config.mode === "subscription" ? config.reportLimit : undefined,
        userLimit: config && config.mode === "subscription" ? config.userLimit : undefined,
        workspaceLimit: config && config.mode === "subscription" ? config.workspaceLimit : undefined,
        subscriptionCurrentPeriodStart: toIsoFromUnix(subscription.current_period_start),
        subscriptionCurrentPeriodEnd: toIsoFromUnix(subscription.current_period_end),
        subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end ? 1 : 0,
    });

    await upsertSubscriptionRecord({
        organizationId: orgId,
        stripeCustomerId: subscription.customer ? String(subscription.customer) : null,
        stripeSubscriptionId: subscription.id,
        plan: resolvedPlan && resolvedPlan !== "onboarding_training" ? resolvedPlan : "trial",
        status: subscription.status || "active",
        currentPeriodEnd: toIsoFromUnix(subscription.current_period_end),
    });
}

async function processStripeWebhookEvent(event) {

    try {
        await db.run(
            "INSERT INTO stripe_webhook_events (stripe_event_id, event_type, processed_at) VALUES (?, ?, ?)",
            event.id,
            event.type,
            nowIso()
        );
    } catch {
        return;
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const metadata = session.metadata || {};
        const orgId = await findOrganizationForStripeEvent({
            organizationId: metadata.organizationId,
            customerId: session.customer,
            subscriptionId: session.subscription,
        });

        if (!orgId) return;

        if (session.mode === "payment" && metadata.plan === "onboarding_training") {
            await markOnboardingPaid(orgId, session.customer ? String(session.customer) : null);
            return;
        }

        if (session.mode === "subscription") {
            const plan = metadata.plan || "none";
            const config = stripePlanConfig[plan];

            await updateOrganizationBillingState(orgId, {
                billingPlan: plan,
                billingStatus: "active",
                plan,
                status: "active",
                trialStatus: "converted",
                stripeCustomerId: session.customer ? String(session.customer) : undefined,
                stripeSubscriptionId: session.subscription ? String(session.subscription) : undefined,
                reportLimit: config ? config.reportLimit : undefined,
                userLimit: config ? config.userLimit : undefined,
                workspaceLimit: config ? config.workspaceLimit : undefined,
            });

            await upsertSubscriptionRecord({
                organizationId: orgId,
                stripeCustomerId: session.customer ? String(session.customer) : null,
                stripeSubscriptionId: session.subscription ? String(session.subscription) : null,
                plan,
                status: "active",
                currentPeriodEnd: null,
            });
        }

        return;
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
        const subscription = event.data.object;
        const metadata = subscription.metadata || {};
        const orgId = await findOrganizationForStripeEvent({
            organizationId: metadata.organizationId,
            subscriptionId: subscription.id,
            customerId: subscription.customer,
        });

        if (!orgId) return;

        await applySubscriptionState(orgId, subscription);
        return;
    }

    if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const metadata = subscription.metadata || {};
        const orgId = await findOrganizationForStripeEvent({
            organizationId: metadata.organizationId,
            subscriptionId: subscription.id,
            customerId: subscription.customer,
        });

        if (!orgId) return;

        await updateOrganizationBillingState(orgId, {
            billingPlan: "none",
            billingStatus: "canceled",
            plan: "none",
            status: "inactive",
            stripeSubscriptionId: subscription.id,
            subscriptionCurrentPeriodStart: toIsoFromUnix(subscription.current_period_start),
            subscriptionCurrentPeriodEnd: toIsoFromUnix(subscription.current_period_end),
            subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end ? 1 : 0,
            reportLimit: 0,
            reportsUsed: 0,
            userLimit: 1,
            workspaceLimit: 1,
        });

        await upsertSubscriptionRecord({
            organizationId: orgId,
            stripeCustomerId: subscription.customer ? String(subscription.customer) : null,
            stripeSubscriptionId: subscription.id,
            plan: "none",
            status: "canceled",
            currentPeriodEnd: toIsoFromUnix(subscription.current_period_end),
        });
    }
}

app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe) {
        res.status(503).json({ error: "Stripe is not configured" });
        return;
    }

    if (!stripeWebhookSecret) {
        res.status(503).json({ error: "Stripe webhook secret is not configured" });
        return;
    }

    const signature = req.header("stripe-signature");
    if (!signature) {
        res.status(400).json({ error: "Missing Stripe signature" });
        return;
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
    } catch (error) {
        res.status(400).json({
            error: "Invalid Stripe webhook signature",
            detail: error instanceof Error ? error.message : "Unknown webhook verification error",
        });
        return;
    }

    try {
        await processStripeWebhookEvent(event);
        res.json({ received: true });
    } catch (error) {
        res.status(500).json({
            error: "Failed to process Stripe webhook",
            detail: error instanceof Error ? error.message : "Unknown webhook processing error",
        });
    }
});

app.use(express.json());

function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

function isBcryptHash(value) {
    return typeof value === "string" && value.startsWith("$2");
}

function hashPassword(plainPassword) {
    return bcrypt.hashSync(String(plainPassword), passwordHashRounds);
}

function verifyPassword(plainPassword, storedPassword) {
    if (!storedPassword) return false;
    if (isBcryptHash(storedPassword)) {
        return bcrypt.compareSync(String(plainPassword), storedPassword);
    }
    return String(storedPassword) === String(plainPassword);
}

function toUserDTO(row) {
    return {
        id: row.id,
        name: row.full_name || "",
        email: row.email,
        organizationId: row.organization_id,
        orgName: row.org_name,
        role: row.role || "owner",
    };
}

function hasPermission(role, permission) {
    return (rolePermissions[role] || []).includes(permission);
}

function toCampaignDTO(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        raceName: row.race_name || "",
        officeType: row.office_type || "",
        location: row.location || "",
        electionDate: row.election_date || "",
        incumbent: row.incumbent || "",
        budgetBand: row.budget_band || "",
        objective: row.objective || "",
        audience: row.audience || "",
        contextNotes: row.context_notes || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapLegacyReportToContract(row) {
    let keySignals = [];
    let actions = [];
    try {
        keySignals = JSON.parse(row.key_signals_json || "[]");
    } catch {
        keySignals = [];
    }
    try {
        actions = JSON.parse(row.actions_json || "[]");
    } catch {
        actions = [];
    }

    const raceSnapshot = String(row.summary || "Strategic report generated from current campaign profile.");
    const opponentWatch = String(keySignals[0] || "Monitor opponent framing shifts and pre-brief rebuttal lines.");
    const messageMemo = String(keySignals[1] || keySignals[0] || "Reinforce one clear voter-facing message with practical proof points.");
    const contentIdeas = keySignals.slice(2, 5).map((v) => String(v));
    const rapidResponsePlan = actions.slice(0, 5).map((v) => String(v));

    return {
        title: row.title,
        confidence: row.confidence,
        raceSnapshot,
        opponentWatch,
        messageMemo,
        contentIdeas: contentIdeas.length > 0 ? contentIdeas : [
            "Create one short post translating message memo into plain voter language.",
            "Publish one quote card anchored to your top issue frame.",
            "Draft one field update tying local concerns to your policy response.",
        ],
        videoAngles: [
            "30-second candidate message on top local issue.",
            "Quick rebuttal clip to latest opponent contrast.",
            "Community-focused walk-and-talk at a recognizable location.",
        ],
        quoteGraphics: [
            "Practical leadership should lower pressure, not raise it.",
            "Families need plans they can feel in everyday life.",
            "Local voices deserve accountable local action.",
        ],
        fundraisingCaptions: [
            "Help us keep this campaign voter-first. Chip in today.",
            "Your support powers outreach this week.",
            "If this message matters, help us scale it now.",
        ],
        rapidResponsePlan: rapidResponsePlan.length > 0 ? rapidResponsePlan : [
            "Publish same-day response with 3 evidence points.",
            "Share aligned talking points with team and volunteers.",
            "Deploy one short video and one quote graphic within 6 hours.",
        ],
        intelligenceSources: {
            userProvidedContext: true,
            electionPredictorUsed: false,
            matchedRaces: [],
            categoriesUsed: ["user notes"],
            lastCheckedAt: row.created_at,
        },
        complianceNote:
            "Campaign teams are responsible for legal review, disclaimer requirements, and final publication approval.",
        summary: raceSnapshot,
        keySignals: keySignals.map((v) => String(v)),
        actions: actions.map((v) => String(v)),
        legacyIntelligenceSources: null,
    };
}

function toReportDTO(row) {
    let payload = null;
    if (row.report_payload_json) {
        try {
            payload = JSON.parse(row.report_payload_json);
        } catch {
            payload = null;
        }
    }

    const contract = payload || mapLegacyReportToContract(row);

    let legacyIntelligenceSources = null;
    if (row.intelligence_sources_json) {
        try {
            legacyIntelligenceSources = JSON.parse(row.intelligence_sources_json);
        } catch {
            legacyIntelligenceSources = null;
        }
    }

    return {
        id: row.id,
        organizationId: row.organization_id,
        campaignId: row.campaign_id,
        createdBy: row.user_id,
        userId: row.user_id,
        title: contract.title,
        confidence: contract.confidence,
        raceSnapshot: contract.raceSnapshot,
        opponentWatch: contract.opponentWatch,
        messageMemo: contract.messageMemo,
        contentIdeas: contract.contentIdeas,
        videoAngles: contract.videoAngles,
        quoteGraphics: contract.quoteGraphics,
        fundraisingCaptions: contract.fundraisingCaptions,
        rapidResponsePlan: contract.rapidResponsePlan,
        intelligenceSources: contract.intelligenceSources,
        complianceNote: contract.complianceNote,
        summary: contract.summary,
        keySignals: contract.keySignals,
        actions: contract.actions,
        legacyIntelligenceSources,
        createdAt: row.created_at,
    };
}

async function requireAuth(req, res, next) {
    const userId = Number(req.header("x-user-id"));
    const organizationId = Number(req.header("x-org-id"));

    if (!Number.isInteger(userId) || !Number.isInteger(organizationId)) {
        res.status(401).json({ error: "Missing auth headers" });
        return;
    }

    const user = await db.get(
        `SELECT u.id, u.organization_id, u.email,
                COALESCE(ou.role, u.role, 'owner') AS role
         FROM users u
                     JOIN organization_users ou
           ON ou.user_id = u.id
          AND ou.organization_id = u.organization_id
          AND ou.status = 'active'
         WHERE u.id = ? AND u.organization_id = ?`,
        userId,
        organizationId
    );

    if (!user) {
        res.status(401).json({ error: "Invalid auth context" });
        return;
    }

    req.auth = {
        userId: user.id,
        organizationId: user.organization_id,
        email: user.email,
        role: String(user.role || "owner").toLowerCase(),
    };

    next();
}

function requirePermission(permission) {
    return (req, res, next) => {
        if (!hasPermission(req.auth.role, permission)) {
            res.status(403).json({ error: `Forbidden: missing permission ${permission}` });
            return;
        }
        next();
    };
}

function requirePremiumFeature(featureLabel) {
    return async (req, res, next) => {
        const entitlements = await getOrganizationEntitlements(req.auth.organizationId);

        if (!entitlements) {
            res.status(404).json({ error: "Organization not found" });
            return;
        }

        req.entitlements = entitlements;

        if (!entitlements.hasPremiumAccess) {
            res.status(402).json({
                error: "UPGRADE_REQUIRED",
                message: "Upgrade to continue generating signal reports.",
                accessState: entitlements.accessState,
            });
            return;
        }

        next();
    };
}

function resolveAppOrigin(req) {
    const fallback = "http://localhost:5173";
    const candidate = req.body?.appOrigin || req.get("origin") || fallback;

    try {
        const url = new URL(candidate);
        return `${url.protocol}//${url.host}`;
    } catch {
        return fallback;
    }
}

function ensureStripeConfigured(res) {
    if (!stripe) {
        res.status(503).json({
            error: "Stripe is not configured",
            detail: "Set STRIPE_SECRET_KEY in your .env file.",
        });
        return false;
    }
    return true;
}

function generateInviteToken() {
    return crypto.randomBytes(24).toString("hex");
}

function toMemberDTO(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        email: row.email,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
    };
}

function toInviteDTO(row, appOrigin) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        email: row.email,
        role: row.role,
        token: row.token,
        status: row.status,
        optionalMessage: row.optional_message,
        invitedBy: row.invited_by,
        expiresAt: row.expires_at,
        acceptedAt: row.accepted_at,
        createdAt: row.created_at,
        acceptLink: `${appOrigin}/accept-invite?token=${row.token}`,
    };
}

async function ownerCountForOrganization(organizationId) {
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM organization_users
         WHERE organization_id = ? AND status = 'active' AND role = 'owner'`,
        organizationId
    );
    return Number(row?.count || 0);
}

async function expirePendingInvites(organizationId) {
    const now = nowIso();
    await db.run(
        `UPDATE organization_invites
         SET status = 'expired'
         WHERE organization_id = ?
           AND status = 'pending'
           AND expires_at <= ?`,
        organizationId,
        now
    );
}

async function writeAuditLog({ organizationId, actorUserId, action, targetUserId = null, targetEmail = null, details = null }) {
    await db.run(
        `INSERT INTO organization_audit_logs (
            organization_id, actor_user_id, action, target_user_id, target_email, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        organizationId,
        actorUserId,
        action,
        targetUserId,
        targetEmail,
        details ? JSON.stringify(details) : null,
        nowIso()
    );
}

function toAuditLogDTO(row) {
    let details = null;
    if (row.details_json) {
        try {
            details = JSON.parse(row.details_json);
        } catch {
            details = null;
        }
    }

    return {
        id: row.id,
        organizationId: row.organization_id,
        actorUserId: row.actor_user_id,
        actorEmail: row.actor_email,
        action: row.action,
        targetUserId: row.target_user_id,
        targetEmail: row.target_email_resolved,
        details,
        createdAt: row.created_at,
    };
}

app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
});

app.get("/api/team", requireAuth, requirePermission("team.view"), requirePremiumFeature("Team features"), async (req, res) => {
    const appOrigin = resolveAppOrigin(req);
    await expirePendingInvites(req.auth.organizationId);

    const memberRows = await db.all(
        `SELECT ou.id, ou.organization_id, ou.user_id, u.email, ou.role, ou.status, ou.created_at
         FROM organization_users ou
         JOIN users u ON u.id = ou.user_id
         WHERE ou.organization_id = ? AND ou.status = 'active'
         ORDER BY CASE ou.role
                    WHEN 'owner' THEN 1
                    WHEN 'admin' THEN 2
                    WHEN 'manager' THEN 3
                    WHEN 'contributor' THEN 4
                    ELSE 5
                  END,
                  LOWER(u.email) ASC`,
        req.auth.organizationId
    );
    const members = memberRows.map(toMemberDTO);

    const inviteRows = await db.all(
        `SELECT id, organization_id, email, role, token, status, optional_message, invited_by,
                expires_at, accepted_at, created_at
         FROM organization_invites
         WHERE organization_id = ?
         ORDER BY created_at DESC`,
        req.auth.organizationId
    );
    const invites = inviteRows.map((row) => toInviteDTO(row, appOrigin));

    const activityRows = await db.all(
        `SELECT l.id, l.organization_id, l.actor_user_id, au.email AS actor_email,
                l.action, l.target_user_id, COALESCE(l.target_email, tu.email) AS target_email_resolved,
                l.details_json, l.created_at
         FROM organization_audit_logs l
         LEFT JOIN users au ON au.id = l.actor_user_id
         LEFT JOIN users tu ON tu.id = l.target_user_id
         WHERE l.organization_id = ?
         ORDER BY l.created_at DESC
         LIMIT 25`,
        req.auth.organizationId
    );
    const activities = activityRows.map(toAuditLogDTO);

    res.json({ members, invites, activities });
});

app.post("/api/team/invites", requireAuth, requirePermission("team.manage"), requirePremiumFeature("Team invites"), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const role = String(req.body?.role || "").trim().toLowerCase();
    const optionalMessage = String(req.body?.message || "").trim();
    const appOrigin = resolveAppOrigin(req);
    await expirePendingInvites(req.auth.organizationId);

    if (!email || !role || !validRoles.has(role)) {
        res.status(400).json({ error: "email and valid role are required" });
        return;
    }

    if (req.auth.role !== "owner" && role === "owner") {
        res.status(403).json({ error: "Only an owner can invite another owner" });
        return;
    }

    const userLimit = req.entitlements.userLimit;
    if (userLimit > 0) {
        const activeUsers = await activeMemberCount(req.auth.organizationId);
        const pendingInvites = await pendingInviteCount(req.auth.organizationId);
        if (activeUsers + pendingInvites >= userLimit) {
            if (req.entitlements.isTrialActive) {
                res.status(409).json({ error: "Team collaboration is available on paid plans." });
                return;
            }
            res.status(409).json({ error: `User limit reached (${userLimit}). Upgrade to add more team members.` });
            return;
        }
    }

    const activeMember = await db.get(
        `SELECT ou.id
         FROM organization_users ou
         JOIN users u ON u.id = ou.user_id
         WHERE ou.organization_id = ? AND ou.status = 'active' AND LOWER(u.email) = ?`,
        req.auth.organizationId,
        email
    );

    if (activeMember) {
        res.status(409).json({ error: "User is already an active team member" });
        return;
    }

    const pendingInvite = await db.get(
        `SELECT id
         FROM organization_invites
         WHERE organization_id = ? AND LOWER(email) = ? AND status = 'pending'`,
        req.auth.organizationId,
        email
    );

    if (pendingInvite) {
        res.status(409).json({ error: "A pending invite already exists for this email" });
        return;
    }

    const token = generateInviteToken();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const inviteRow = await db.get(
        `INSERT INTO organization_invites (
          organization_id, email, role, token, status, invited_by, optional_message, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        RETURNING id, organization_id, email, role, token, status, optional_message, invited_by,
                  expires_at, accepted_at, created_at`,
        req.auth.organizationId,
        email,
        role,
        token,
        req.auth.userId,
        optionalMessage || null,
        expiresAt,
        createdAt
    );

    const invite = toInviteDTO(inviteRow, appOrigin);
    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "team.invite.created",
        targetEmail: email,
        details: { role },
    });
    res.status(201).json({
        invite,
        inviteLink: invite.acceptLink,
        note: "Email sending is placeholder in v1. Share inviteLink manually.",
    });
});

app.post("/api/team/invites/:token/accept", async (req, res) => {
    const token = String(req.params.token || "").trim();
    const password = String(req.body?.password || "").trim();
    const hashedPassword = hashPassword(password);
    const emailOverride = normalizeEmail(req.body?.email);

    if (!token || !password) {
        res.status(400).json({ error: "token and password are required" });
        return;
    }

    const invite = await db.get(
        `SELECT id, organization_id, email, role, status, expires_at
         FROM organization_invites
         WHERE token = ?`,
        token
    );

    if (!invite) {
        res.status(404).json({ error: "Invite not found" });
        return;
    }

    if (invite.status !== "pending") {
        res.status(409).json({ error: `Invite is ${invite.status}` });
        return;
    }

    if (new Date(invite.expires_at).getTime() < Date.now()) {
        await db.run("UPDATE organization_invites SET status = 'expired' WHERE id = ?", invite.id);
        res.status(410).json({ error: "Invite expired" });
        return;
    }

    const invitedEmail = normalizeEmail(invite.email);
    if (emailOverride && emailOverride !== invitedEmail) {
        res.status(400).json({ error: "Invite email does not match" });
        return;
    }

    const org = await db.get("SELECT id, name FROM organizations WHERE id = ?", invite.organization_id);

    if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
    }

    const entitlements = await getOrganizationEntitlements(invite.organization_id);
    if (!entitlements || !entitlements.hasPremiumAccess) {
        res.status(402).json({ error: "Organization trial has expired. Start a subscription to accept this invite." });
        return;
    }

    if (entitlements.userLimit > 0 && await activeMemberCount(invite.organization_id) >= entitlements.userLimit) {
        if (entitlements.isTrialActive) {
            res.status(409).json({ error: "Trial limit reached: 2 users total (owner + 1 teammate). Upgrade to add teammates." });
            return;
        }
        res.status(409).json({ error: `Organization user limit reached (${entitlements.userLimit}).` });
        return;
    }

    const acceptedAt = nowIso();

    const user = await db.transaction(async (tx) => {
        let existingUser = await tx.get(
            "SELECT id, email, organization_id FROM users WHERE organization_id = ? AND email = ?",
            invite.organization_id,
            invitedEmail
        );

        if (!existingUser) {
            existingUser = await tx.get(
                `INSERT INTO users (organization_id, email, password, role, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 RETURNING id, email, organization_id`,
                invite.organization_id,
                invitedEmail,
                hashedPassword,
                invite.role,
                acceptedAt
            );
        } else {
            await tx.run("UPDATE users SET password = ? WHERE id = ?", hashedPassword, existingUser.id);
        }

        await tx.run(
            `INSERT INTO organization_users (organization_id, user_id, role, status, created_at)
             VALUES (?, ?, ?, 'active', ?)
             ON CONFLICT(organization_id, user_id)
             DO UPDATE SET role = excluded.role, status = 'active'`,
            invite.organization_id,
            existingUser.id,
            invite.role,
            acceptedAt
        );

        await tx.run("UPDATE organization_invites SET status = 'accepted', accepted_at = ? WHERE id = ?", acceptedAt, invite.id);

        await tx.run(
            `INSERT INTO organization_audit_logs (
                organization_id, actor_user_id, action, target_user_id, target_email, details_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            invite.organization_id,
            existingUser.id,
            "team.invite.accepted",
            existingUser.id,
            invitedEmail,
            JSON.stringify({ role: invite.role }),
            nowIso()
        );

        return tx.get(
            `SELECT u.id, u.email, u.organization_id, o.name AS org_name,
                    COALESCE(ou.role, u.role, 'owner') AS role
             FROM users u
             JOIN organizations o ON o.id = u.organization_id
             LEFT JOIN organization_users ou
               ON ou.user_id = u.id
              AND ou.organization_id = u.organization_id
              AND ou.status = 'active'
             WHERE u.id = ?`,
            existingUser.id
        );
    });

    res.json({ user: toUserDTO(user), organizationName: org.name });
});

app.post("/api/team/invites/:id/resend", requireAuth, requirePermission("team.manage"), requirePremiumFeature("Team invites"), async (req, res) => {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId)) {
        res.status(400).json({ error: "Invalid invite id" });
        return;
    }

    const invite = await db.get(
        `SELECT id, organization_id, email, role, token, status, optional_message, invited_by,
                expires_at, accepted_at, created_at
         FROM organization_invites
         WHERE id = ? AND organization_id = ?`,
        inviteId,
        req.auth.organizationId
    );

    if (!invite) {
        res.status(404).json({ error: "Invite not found" });
        return;
    }

    if (invite.status === "accepted") {
        res.status(409).json({ error: "Invite already accepted" });
        return;
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.run("UPDATE organization_invites SET status = 'pending', expires_at = ? WHERE id = ?", expiresAt, invite.id);

    const appOrigin = resolveAppOrigin(req);
    const updatedInvite = await db.get(
        `SELECT id, organization_id, email, role, token, status, optional_message, invited_by,
                expires_at, accepted_at, created_at
         FROM organization_invites
         WHERE id = ?`,
        invite.id
    );

    const dto = toInviteDTO(updatedInvite, appOrigin);
    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "team.invite.resent",
        targetEmail: updatedInvite.email,
        details: { inviteId: updatedInvite.id },
    });
    res.json({ invite: dto, inviteLink: dto.acceptLink });
});

app.post("/api/team/invites/:id/revoke", requireAuth, requirePermission("team.manage"), requirePremiumFeature("Team invites"), async (req, res) => {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId)) {
        res.status(400).json({ error: "Invalid invite id" });
        return;
    }

    const invite = await db.get(
        "SELECT id, status FROM organization_invites WHERE id = ? AND organization_id = ?",
        inviteId,
        req.auth.organizationId
    );

    if (!invite) {
        res.status(404).json({ error: "Invite not found" });
        return;
    }

    if (invite.status === "accepted") {
        res.status(409).json({ error: "Cannot revoke an accepted invite" });
        return;
    }

    await db.run("UPDATE organization_invites SET status = 'revoked' WHERE id = ?", inviteId);
    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "team.invite.revoked",
        details: { inviteId },
    });
    res.json({ ok: true });
});

app.patch("/api/team/members/:id/role", requireAuth, requirePermission("team.manage"), requirePremiumFeature("Team roles"), async (req, res) => {
    const memberId = Number(req.params.id);
    const newRole = String(req.body?.role || "").trim().toLowerCase();

    if (!Number.isInteger(memberId) || !validRoles.has(newRole)) {
        res.status(400).json({ error: "Invalid member id or role" });
        return;
    }

    const member = await db.get(
        `SELECT id, organization_id, user_id, role, status
         FROM organization_users
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
        memberId,
        req.auth.organizationId
    );

    if (!member) {
        res.status(404).json({ error: "Member not found" });
        return;
    }

    if (req.auth.role !== "owner" && member.role === "owner") {
        res.status(403).json({ error: "Admin cannot change owner role" });
        return;
    }

    if (req.auth.role !== "owner" && newRole === "owner") {
        res.status(403).json({ error: "Only owner can assign owner role" });
        return;
    }

    if (member.user_id === req.auth.userId && member.role === "owner" && newRole !== "owner") {
        if (await ownerCountForOrganization(req.auth.organizationId) <= 1) {
            res.status(409).json({ error: "Cannot demote the only owner" });
            return;
        }
    }

    await db.run("UPDATE organization_users SET role = ? WHERE id = ? AND organization_id = ?", newRole, memberId, req.auth.organizationId);

    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "team.member.role_changed",
        targetUserId: member.user_id,
        details: { previousRole: member.role, newRole },
    });

    const row = await db.get(
        `SELECT ou.id, ou.organization_id, ou.user_id, u.email, ou.role, ou.status, ou.created_at
         FROM organization_users ou
         JOIN users u ON u.id = ou.user_id
         WHERE ou.id = ?`,
        memberId
    );

    res.json({ member: toMemberDTO(row) });
});

app.delete("/api/team/members/:id", requireAuth, requirePermission("team.manage"), requirePremiumFeature("Team management"), async (req, res) => {
    const memberId = Number(req.params.id);

    if (!Number.isInteger(memberId)) {
        res.status(400).json({ error: "Invalid member id" });
        return;
    }

    const member = await db.get(
        `SELECT id, organization_id, user_id, role, status
         FROM organization_users
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
        memberId,
        req.auth.organizationId
    );

    if (!member) {
        res.status(404).json({ error: "Member not found" });
        return;
    }

    if (req.auth.role !== "owner" && member.role === "owner") {
        res.status(403).json({ error: "Admin cannot remove owner" });
        return;
    }

    if (member.user_id === req.auth.userId && member.role === "owner") {
        if (await ownerCountForOrganization(req.auth.organizationId) <= 1) {
            res.status(409).json({ error: "Cannot remove yourself as the only owner" });
            return;
        }
    }

    await db.run("UPDATE organization_users SET status = 'removed' WHERE id = ? AND organization_id = ?", memberId, req.auth.organizationId);

    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "team.member.removed",
        targetUserId: member.user_id,
        details: { removedRole: member.role },
    });

    res.json({ ok: true });
});

app.get("/api/billing/config", (_req, res) => {
    res.json({
        publishableKeyConfigured: Boolean(process.env.STRIPE_PUBLISHABLE_KEY),
        webhookConfigured: Boolean(stripeWebhookSecret),
    });
});

app.post("/api/billing/checkout-session", requireAuth, requirePermission("billing.manage"), async (req, res) => {
    if (!ensureStripeConfigured(res)) return;

    const plan = String(req.body?.plan || "").trim();
    const config = stripePlanConfig[plan];
    if (!config) {
        res.status(400).json({ error: "Invalid plan" });
        return;
    }

    const appOrigin = resolveAppOrigin(req);
    const configuredPrice = process.env[config.priceEnv];

    const lineItem = configuredPrice
        ? { price: configuredPrice, quantity: 1 }
        : {
            price_data: {
                currency: "usd",
                ...(config.mode === "subscription" ? { recurring: { interval: "month" } } : {}),
                product_data: {
                    name: `Campaign Signal Studio - ${config.label}`,
                },
                unit_amount: config.amount,
            },
            quantity: 1,
        };

    try {
        const metadata = {
            organizationId: String(req.auth.organizationId),
            userId: String(req.auth.userId),
            plan,
            report_limit: String(config.reportLimit),
            workspace_limit: String(config.workspaceLimit),
            user_limit: String(config.userLimit),
        };

        const session = await stripe.checkout.sessions.create({
            mode: config.mode,
            line_items: [lineItem],
            customer_email: req.auth.email,
            success_url: `${appOrigin}/pricing?checkout=success`,
            cancel_url: `${appOrigin}/pricing?checkout=cancelled`,
            metadata,
            ...(config.mode === "subscription" ? { subscription_data: { metadata } } : {}),
            ...(config.mode === "payment" ? { payment_intent_data: { metadata } } : {}),
        });

        res.json({
            id: session.id,
            url: session.url,
        });
    } catch (error) {
        res.status(502).json({
            error: "Failed to create Stripe checkout session",
            detail: error instanceof Error ? error.message : "Unknown Stripe error",
        });
    }
});

app.post("/api/auth/signup", async (req, res) => {
    const fullName = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const orgName = String(req.body?.orgName || "").trim();
    const organizationType = String(req.body?.organizationType || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !email || !orgName || !organizationType || !password) {
        res.status(400).json({ error: "name, email, orgName, organizationType, and password are required" });
        return;
    }

    if (!validOrganizationTypes.has(organizationType)) {
        res.status(400).json({ error: "Invalid organization type" });
        return;
    }

    const existingOrg = await db.get("SELECT id FROM organizations WHERE name = ?", orgName);
    if (existingOrg) {
        res.status(409).json({ error: "Organization already exists. Use login." });
        return;
    }

    const createdAt = nowIso();
    const hashedPassword = hashPassword(password);
    const trialEndsAt = addDaysToIso(createdAt, trialConfig.days);
    const userRow = await db.transaction(async (tx) => {
        const orgResult = await tx.get(
            "INSERT INTO organizations (name, organization_type, created_at) VALUES (?, ?, ?) RETURNING id",
            orgName,
            organizationType,
            createdAt
        );
        const organizationId = Number(orgResult.id);

        await tx.run(
            `UPDATE organizations
             SET billing_plan = 'trial',
                 billing_status = 'trialing',
                 plan = 'trial',
                 status = 'trialing',
                 trial_status = 'active',
                 trial_started_at = ?,
                 trial_ends_at = ?,
                 report_limit = ?,
                 reports_used = 0,
                 user_limit = ?,
                 workspace_limit = ?,
                 billing_updated_at = ?
             WHERE id = ?`,
            createdAt,
            trialEndsAt,
            trialConfig.reportLimit,
            trialConfig.userLimit,
            trialConfig.workspaceLimit,
            createdAt,
            organizationId
        );

        const createdUser = await tx.get(
            `INSERT INTO users (organization_id, full_name, email, password, role, created_at)
             VALUES (?, ?, ?, ?, 'owner', ?)
             RETURNING id`,
            organizationId,
            fullName,
            email,
            hashedPassword,
            createdAt
        );
        const userId = Number(createdUser.id);

        await tx.run(
            `INSERT INTO organization_users (organization_id, user_id, role, status, created_at)
             VALUES (?, ?, 'owner', 'active', ?)`,
            organizationId,
            userId,
            createdAt
        );

        return tx.get(
            `SELECT u.id, u.email, u.organization_id, o.name AS org_name,
                    u.full_name,
                    COALESCE(ou.role, u.role, 'owner') AS role
             FROM users u
             JOIN organizations o ON o.id = u.organization_id
             LEFT JOIN organization_users ou
               ON ou.user_id = u.id
              AND ou.organization_id = u.organization_id
              AND ou.status = 'active'
             WHERE u.id = ?`,
            userId
        );
    });

    const user = toUserDTO(userRow);
    res.status(201).json({ user });
});

app.post("/api/auth/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const orgName = String(req.body?.orgName || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!email || !orgName || !password) {
        res.status(400).json({ error: "email, orgName, and password are required" });
        return;
    }

    const row = await db.get(
        `SELECT u.id, u.email, u.organization_id, o.name AS org_name, u.full_name, u.password,
                COALESCE(ou.role, u.role, 'owner') AS role
         FROM users u
         JOIN organizations o ON o.id = u.organization_id
         JOIN organization_users ou
           ON ou.user_id = u.id
          AND ou.organization_id = u.organization_id
          AND ou.status = 'active'
         WHERE u.email = ? AND o.name = ?`,
        email,
        orgName
    );

    if (!row || !verifyPassword(password, row.password)) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
    }

    if (!isBcryptHash(row.password)) {
        await db.run("UPDATE users SET password = ? WHERE id = ?", hashPassword(password), row.id);
    }

    const user = toUserDTO(row);
    res.json({ user });
});

app.get("/api/organization", requireAuth, async (req, res) => {
    const entitlements = await getOrganizationEntitlements(req.auth.organizationId);

    if (!entitlements) {
        res.status(404).json({ error: "Organization not found" });
        return;
    }

    const org = entitlements.org;

    const campaignCount = (await db.get("SELECT COUNT(*) AS count FROM campaigns WHERE organization_id = ?", req.auth.organizationId)).count;

    const reportCount = (await db.get("SELECT COUNT(*) AS count FROM signal_reports WHERE organization_id = ?", req.auth.organizationId)).count;

    const userCount = (await db.get("SELECT COUNT(*) AS count FROM users WHERE organization_id = ?", req.auth.organizationId)).count;

    res.json({
        organization: {
            id: org.id,
            name: org.name,
            organizationType: org.organization_type || "Other",
            capabilities: {
                basicTemplates: true,
                advancedTemplates: entitlements.isSubscribed,
                deepIntelligence: entitlements.isSubscribed,
                pdfExport: entitlements.isSubscribed,
                contentCalendar: false,
                prioritySupport: entitlements.isSubscribed,
                fullTeamAdmin: entitlements.isSubscribed,
                fullBillingAdmin: entitlements.isSubscribed,
            },
            supportAccessEnabled: Boolean(org.support_access_enabled),
            workspaceModel: "campaign_record",
            plan: org.plan || org.billing_plan,
            status: org.status || org.billing_status,
            billingPlan: org.billing_plan,
            billingStatus: org.billing_status,
            trialStatus: org.trial_status,
            trialStartedAt: org.trial_started_at,
            trialEndsAt: org.trial_ends_at,
            accessState: entitlements.accessState,
            hasPremiumAccess: entitlements.hasPremiumAccess,
            isSubscribed: entitlements.isSubscribed,
            isTrialActive: entitlements.isTrialActive,
            trialDaysRemaining: entitlements.trialDaysRemaining,
            reportLimitWindow: entitlements.reportLimitWindow,
            reportLimit: org.report_limit,
            userLimit: org.user_limit,
            workspaceLimit: org.workspace_limit,
            usage: {
                reportsUsed: entitlements.isTrialActive
                    ? await trialGeneratedReportCount(req.auth.organizationId)
                    : await monthlyReportCount(req.auth.organizationId),
                reportsLimit: Number(org.report_limit || 0),
                reportsWindow: entitlements.reportLimitWindow,
                campaignsUsed: campaignCount,
                campaignLimit: Number(org.workspace_limit || 0),
                usersUsed: await activeMemberCount(req.auth.organizationId),
                userLimit: Number(org.user_limit || 0),
            },
            reportsUsed: Number(org.reports_used || 0),
            onboardingPaidAt: org.onboarding_paid_at,
            subscriptionCurrentPeriodStart: org.subscription_current_period_start,
            subscriptionCurrentPeriodEnd: org.subscription_current_period_end,
            subscriptionCancelAtPeriodEnd: Boolean(org.subscription_cancel_at_period_end),
            createdAt: org.created_at,
        },
        currentUserRole: req.auth.role,
        stats: {
            campaignCount,
            reportCount,
            userCount,
        },
    });
});

app.patch("/api/organization/support-access", requireAuth, requirePermission("support.enable"), requirePremiumFeature("Support access controls"), async (req, res) => {
    const enabled = Boolean(req.body?.enabled);

    await db.run("UPDATE organizations SET support_access_enabled = ? WHERE id = ?",
        enabled ? 1 : 0,
        req.auth.organizationId
    );

    const entitlements = await getOrganizationEntitlements(req.auth.organizationId);
    if (!entitlements) {
        res.status(404).json({ error: "Organization not found" });
        return;
    }

    const org = entitlements.org;

    res.json({
        organization: {
            id: org.id,
            name: org.name,
            organizationType: org.organization_type || "Other",
            capabilities: {
                basicTemplates: true,
                advancedTemplates: entitlements.isSubscribed,
                deepIntelligence: entitlements.isSubscribed,
                pdfExport: entitlements.isSubscribed,
                contentCalendar: false,
                prioritySupport: entitlements.isSubscribed,
                fullTeamAdmin: entitlements.isSubscribed,
                fullBillingAdmin: entitlements.isSubscribed,
            },
            supportAccessEnabled: Boolean(org.support_access_enabled),
            workspaceModel: "campaign_record",
            plan: org.plan || org.billing_plan,
            status: org.status || org.billing_status,
            billingPlan: org.billing_plan,
            billingStatus: org.billing_status,
            trialStatus: org.trial_status,
            trialStartedAt: org.trial_started_at,
            trialEndsAt: org.trial_ends_at,
            accessState: entitlements.accessState,
            hasPremiumAccess: entitlements.hasPremiumAccess,
            isSubscribed: entitlements.isSubscribed,
            isTrialActive: entitlements.isTrialActive,
            trialDaysRemaining: entitlements.trialDaysRemaining,
            reportLimitWindow: entitlements.reportLimitWindow,
            reportLimit: org.report_limit,
            userLimit: org.user_limit,
            workspaceLimit: org.workspace_limit,
            createdAt: org.created_at,
        },
    });
});

app.get("/api/campaigns", requireAuth, requirePermission("campaign.view"), async (req, res) => {
    const rows = await db.all("SELECT * FROM campaigns WHERE organization_id = ? ORDER BY updated_at DESC", req.auth.organizationId);

    res.json({ campaigns: rows.map(toCampaignDTO) });
});

app.post("/api/campaigns", requireAuth, requirePermission("campaign.manage"), async (req, res) => {
    const body = req.body || {};
    const now = nowIso();

    if (body.id) {
        const existing = await db.get("SELECT id FROM campaigns WHERE id = ? AND organization_id = ?", body.id, req.auth.organizationId);

        if (!existing) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }

        await db.run(
            `UPDATE campaigns
       SET race_name = ?, office_type = ?, location = ?, election_date = ?, incumbent = ?,
           budget_band = ?, objective = ?, audience = ?, context_notes = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
            body.raceName || "",
            body.officeType || "",
            body.location || "",
            body.electionDate || "",
            body.incumbent || "",
            body.budgetBand || "",
            body.objective || "",
            body.audience || "",
            body.contextNotes || "",
            now,
            body.id,
            req.auth.organizationId
        );

        const row = await db.get("SELECT * FROM campaigns WHERE id = ? AND organization_id = ?", body.id, req.auth.organizationId);

        res.json({ campaign: toCampaignDTO(row) });
        return;
    }

    const entitlements = await getOrganizationEntitlements(req.auth.organizationId);
    if (!entitlements) {
        res.status(404).json({ error: "Organization not found" });
        return;
    }

    if (entitlements.workspaceLimit > 0) {
        const usedWorkspaces = await campaignWorkspaceCount(req.auth.organizationId);
        if (usedWorkspaces >= entitlements.workspaceLimit) {
            if (entitlements.isTrialActive) {
                res.status(409).json({ error: "Multiple campaign workspaces are available on Professional and Consultant plans." });
                return;
            }
            res.status(409).json({ error: `Workspace limit reached (${entitlements.workspaceLimit}). Upgrade to create more campaign workspaces.` });
            return;
        }
    }

    const row = await db.get(
        `INSERT INTO campaigns (
        organization_id, user_id, race_name, office_type, location, election_date,
        incumbent, budget_band, objective, audience, context_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`,
        req.auth.organizationId,
        req.auth.userId,
        body.raceName || "",
        body.officeType || "",
        body.location || "",
        body.electionDate || "",
        body.incumbent || "",
        body.budgetBand || "",
        body.objective || "",
        body.audience || "",
        body.contextNotes || "",
        now,
        now
    );

    res.status(201).json({ campaign: toCampaignDTO(row) });
});

app.get("/api/reports", requireAuth, requirePermission("reports.view"), async (req, res) => {
    const rows = await db.all("SELECT * FROM signal_reports WHERE organization_id = ? ORDER BY created_at DESC", req.auth.organizationId);

    res.json({ reports: rows.map(toReportDTO) });
});

app.delete("/api/reports/:id", requireAuth, requirePermission("reports.delete"), async (req, res) => {
    const reportId = Number(req.params.id);
    if (!Number.isInteger(reportId)) {
        res.status(400).json({ error: "Invalid report id" });
        return;
    }

    const report = await db.get("SELECT id FROM signal_reports WHERE id = ? AND organization_id = ?", reportId, req.auth.organizationId);

    if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
    }

    await db.run("DELETE FROM signal_reports WHERE id = ? AND organization_id = ?", reportId, req.auth.organizationId);

    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "report.deleted",
        details: { reportId },
    });

    res.json({ ok: true });
});

app.post("/api/reports/generate", requireAuth, requirePermission("reports.generate"), requirePremiumFeature("Signal Report generation"), async (req, res) => {
    const campaignId = Number(req.body?.campaignId);
    const contextNotesOverride = typeof req.body?.contextNotes === "string" ? req.body.contextNotes : null;

    if (!Number.isInteger(campaignId)) {
        res.status(400).json({ error: "campaignId is required" });
        return;
    }

    const campaign = await db.get("SELECT * FROM campaigns WHERE id = ? AND organization_id = ?", campaignId, req.auth.organizationId);

    if (!campaign) {
        res.status(404).json({ error: "Campaign not found" });
        return;
    }

    const orgStatus = resolveOrganizationStatus(req.entitlements.org);
    const reportsUsed = orgStatus === "trialing"
        ? await trialGeneratedReportCount(req.auth.organizationId)
        : await monthlyReportCount(req.auth.organizationId);

    const allowed = canGenerateReport({
        status: orgStatus,
        reportsUsed,
        reportLimit: Number(req.entitlements.reportLimit || 0),
        trialEndsAt: req.entitlements.org.trial_ends_at,
    });

    if (!allowed) {
        res.status(402).json({
            error: "UPGRADE_REQUIRED",
            message: "Upgrade to continue generating signal reports.",
        });
        return;
    }

    const generatorInput = {
        raceName: campaign.race_name,
        officeType: campaign.office_type,
        location: campaign.location,
        electionDate: campaign.election_date,
        incumbent: campaign.incumbent,
        budgetBand: campaign.budget_band,
        objective: campaign.objective,
        audience: campaign.audience,
        contextNotes: contextNotesOverride ?? campaign.context_notes,
    };

    let generated;
    try {
        generated = await generateCampaignSignalReport(generatorInput, {
            useDeepIntelligence: req.entitlements.isSubscribed,
        });
    } catch (error) {
        res.status(502).json({
            error: "Failed to generate report",
            detail: error instanceof Error ? error.message : "Unknown generator error",
        });
        return;
    }
    const createdAt = nowIso();

    const row = await db.get(
        `INSERT INTO signal_reports (
        organization_id, campaign_id, user_id, title, summary, confidence,
                key_signals_json, actions_json, report_payload_json, intelligence_sources_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING *`,
        req.auth.organizationId,
        campaign.id,
        req.auth.userId,
        generated.title,
        generated.raceSnapshot,
        generated.confidence,
        JSON.stringify(generated.keySignals),
        JSON.stringify(generated.actions),
        JSON.stringify({
            title: generated.title,
            confidence: generated.confidence,
            raceSnapshot: generated.raceSnapshot,
            opponentWatch: generated.opponentWatch,
            messageMemo: generated.messageMemo,
            contentIdeas: generated.contentIdeas,
            videoAngles: generated.videoAngles,
            quoteGraphics: generated.quoteGraphics,
            fundraisingCaptions: generated.fundraisingCaptions,
            rapidResponsePlan: generated.rapidResponsePlan,
            intelligenceSources: generated.intelligenceSources,
            complianceNote: generated.complianceNote,
            summary: generated.summary,
            keySignals: generated.keySignals,
            actions: generated.actions,
        }),
        generated.legacyIntelligenceSources ? JSON.stringify(generated.legacyIntelligenceSources) : null,
        createdAt
    );

    await db.run("UPDATE organizations SET reports_used = reports_used + 1 WHERE id = ?", req.auth.organizationId);

    await writeAuditLog({
        organizationId: req.auth.organizationId,
        actorUserId: req.auth.userId,
        action: "report.generated",
        details: { reportId: row.id },
    });

    res.status(201).json({ report: toReportDTO(row) });
});

app.delete("/api/campaigns/:id", requireAuth, requirePermission("campaign.manage"), async (req, res) => {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId)) {
        res.status(400).json({ error: "Invalid campaign id" });
        return;
    }

    const campaign = await db.get("SELECT id FROM campaigns WHERE id = ? AND organization_id = ?", campaignId, req.auth.organizationId);

    if (!campaign) {
        res.status(404).json({ error: "Campaign not found" });
        return;
    }

    await db.transaction(async (tx) => {
        const removedReport = await tx.get(
            "SELECT COUNT(*) AS count FROM signal_reports WHERE campaign_id = ? AND organization_id = ?",
            campaignId,
            req.auth.organizationId
        );
        const removedReportCount = Number(removedReport?.count || 0);

        await tx.run("DELETE FROM signal_reports WHERE campaign_id = ? AND organization_id = ?", campaignId, req.auth.organizationId);
        await tx.run("DELETE FROM campaigns WHERE id = ? AND organization_id = ?", campaignId, req.auth.organizationId);

        await tx.run(
            `INSERT INTO organization_audit_logs (
                organization_id, actor_user_id, action, target_user_id, target_email, details_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            req.auth.organizationId,
            req.auth.userId,
            "campaign.deleted",
            null,
            null,
            JSON.stringify({ campaignId, removedReportCount }),
            nowIso()
        );
    });
    res.json({ ok: true });
});

app.listen(port, () => {
    console.log(`Campaign Signal Studio API running on http://localhost:${port}`);
    db.provider().then((provider) => {
        console.log(`Database provider: ${provider}`);
    }).catch((error) => {
        console.error("Failed to resolve database provider:", error instanceof Error ? error.message : error);
    });
});
