import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { neonSchemaSql } from "./scripts/neon-schema-sql.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "campaign-signal.db");
const hasNeonConnection = Boolean(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);
const defaultProvider = process.env.NODE_ENV === "production" || hasNeonConnection ? "neon" : "sqlite";
const dbProvider = String(process.env.DB_PROVIDER || defaultProvider).toLowerCase();
const neonSchema = process.env.NEON_SCHEMA || "campaign_signal";

function nowIso() {
    return new Date().toISOString();
}

function withPgSslMode(connectionString) {
    const parsed = new URL(connectionString);
    const sslmode = parsed.searchParams.get("sslmode");
    const useLibpqCompat = parsed.searchParams.get("uselibpqcompat");

    if (sslmode === "require" && useLibpqCompat !== "true") {
        parsed.searchParams.set("sslmode", "verify-full");
        console.warn("Adjusted sslmode=require to sslmode=verify-full for explicit secure behavior.");
    }

    return parsed.toString();
}

function sqliteResultFromRun(result) {
    return {
        changes: Number(result?.changes || 0),
        lastInsertRowid: typeof result?.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : Number(result?.lastInsertRowid || 0),
    };
}

function convertQuestionPlaceholders(sql) {
    let parameterIndex = 0;
    return sql.replace(/\?/g, () => {
        parameterIndex += 1;
        return `$${parameterIndex}`;
    });
}

function normalizePgResultValue(value) {
    if (typeof value === "bigint") {
        return Number(value);
    }
    return value;
}

function normalizePgRow(row) {
    if (!row || typeof row !== "object") return row;
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizePgResultValue(value);
    }
    return normalized;
}

function createSqliteAdapter() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        full_name TEXT,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        UNIQUE(organization_id, email)
      );

      CREATE TABLE IF NOT EXISTS organization_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        UNIQUE(organization_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS organization_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        invited_by INTEGER NOT NULL,
        optional_message TEXT,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organization_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        actor_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        target_user_id INTEGER,
        target_email TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
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

      CREATE TABLE IF NOT EXISTS signal_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        confidence TEXT NOT NULL,
        key_signals_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
                report_payload_json TEXT,
        intelligence_sources_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        current_period_end TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(organization_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
    `);

    const signalReportColumns = sqlite.prepare("PRAGMA table_info(signal_reports)").all();
    const hasReportPayloadColumn = signalReportColumns.some((col) => col.name === "report_payload_json");
    if (!hasReportPayloadColumn) {
        sqlite.exec("ALTER TABLE signal_reports ADD COLUMN report_payload_json TEXT");
    }

    return {
        provider: "sqlite",
        async get(sql, ...params) {
            return sqlite.prepare(sql).get(...params);
        },
        async all(sql, ...params) {
            return sqlite.prepare(sql).all(...params);
        },
        async run(sql, ...params) {
            const result = sqlite.prepare(sql).run(...params);
            return sqliteResultFromRun(result);
        },
        async transaction(callback) {
            sqlite.exec("BEGIN");
            try {
                const output = await callback({
                    get: async (sql, ...params) => sqlite.prepare(sql).get(...params),
                    all: async (sql, ...params) => sqlite.prepare(sql).all(...params),
                    run: async (sql, ...params) => sqliteResultFromRun(sqlite.prepare(sql).run(...params)),
                });
                sqlite.exec("COMMIT");
                return output;
            } catch (error) {
                sqlite.exec("ROLLBACK");
                throw error;
            }
        },
        async close() {
            sqlite.close();
        },
    };
}

async function createNeonAdapter() {
    const rawConnectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
    if (!rawConnectionString) {
        throw new Error("Missing NEON_DATABASE_URL (or DATABASE_URL) for Neon provider.");
    }

    const connectionString = withPgSslMode(rawConnectionString);
    const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
    });

    const initClient = await pool.connect();
    try {
        await initClient.query(`SET search_path TO ${neonSchema}, public`);
        await initClient.query(neonSchemaSql);
    } finally {
        initClient.release();
    }

    return {
        provider: "neon",
        async get(sql, ...params) {
            const client = await pool.connect();
            const pgSql = convertQuestionPlaceholders(sql);
            try {
                await client.query(`SET search_path TO ${neonSchema}, public`);
                const result = await client.query(pgSql, params);
                return result.rows[0] ? normalizePgRow(result.rows[0]) : undefined;
            } finally {
                client.release();
            }
        },
        async all(sql, ...params) {
            const client = await pool.connect();
            const pgSql = convertQuestionPlaceholders(sql);
            try {
                await client.query(`SET search_path TO ${neonSchema}, public`);
                const result = await client.query(pgSql, params);
                return result.rows.map((row) => normalizePgRow(row));
            } finally {
                client.release();
            }
        },
        async run(sql, ...params) {
            const client = await pool.connect();
            const pgSql = convertQuestionPlaceholders(sql);
            try {
                await client.query(`SET search_path TO ${neonSchema}, public`);
                const result = await client.query(pgSql, params);
                return {
                    changes: Number(result.rowCount || 0),
                    lastInsertRowid: 0,
                    rows: result.rows.map((row) => normalizePgRow(row)),
                };
            } finally {
                client.release();
            }
        },
        async transaction(callback) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(`SET LOCAL search_path TO ${neonSchema}, public`);

                const tx = {
                    get: async (sql, ...params) => {
                        const pgSql = convertQuestionPlaceholders(sql);
                        const result = await client.query(pgSql, params);
                        return result.rows[0] ? normalizePgRow(result.rows[0]) : undefined;
                    },
                    all: async (sql, ...params) => {
                        const pgSql = convertQuestionPlaceholders(sql);
                        const result = await client.query(pgSql, params);
                        return result.rows.map((row) => normalizePgRow(row));
                    },
                    run: async (sql, ...params) => {
                        const pgSql = convertQuestionPlaceholders(sql);
                        const result = await client.query(pgSql, params);
                        return {
                            changes: Number(result.rowCount || 0),
                            lastInsertRowid: 0,
                            rows: result.rows.map((row) => normalizePgRow(row)),
                        };
                    },
                };

                const output = await callback(tx);
                await client.query("COMMIT");
                return output;
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        },
        async close() {
            await pool.end();
        },
    };
}

let adapterPromise;

async function getAdapter() {
    if (!adapterPromise) {
        adapterPromise = dbProvider === "neon" ? createNeonAdapter() : Promise.resolve(createSqliteAdapter());
    }
    return adapterPromise;
}

const db = {
    async get(sql, ...params) {
        const adapter = await getAdapter();
        return adapter.get(sql, ...params);
    },
    async all(sql, ...params) {
        const adapter = await getAdapter();
        return adapter.all(sql, ...params);
    },
    async run(sql, ...params) {
        const adapter = await getAdapter();
        return adapter.run(sql, ...params);
    },
    async transaction(callback) {
        const adapter = await getAdapter();
        return adapter.transaction(callback);
    },
    async provider() {
        const adapter = await getAdapter();
        return adapter.provider;
    },
    async close() {
        const adapter = await getAdapter();
        await adapter.close();
    },
};

export { nowIso, dbProvider, neonSchema };
export default db;
