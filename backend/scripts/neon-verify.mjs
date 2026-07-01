import "dotenv/config";
import { Pool } from "pg";

const normalizeConnectionString = (rawConnectionString) => {
    const parsed = new URL(rawConnectionString);
    const sslmode = parsed.searchParams.get("sslmode");
    const useLibpqCompat = parsed.searchParams.get("uselibpqcompat");

    if (sslmode === "require" && useLibpqCompat !== "true") {
        parsed.searchParams.set("sslmode", "verify-full");
        console.warn("Adjusted sslmode=require to sslmode=verify-full for explicit secure behavior.");
    }

    return parsed.toString();
};

const rawConnectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
const connectionString = rawConnectionString ? normalizeConnectionString(rawConnectionString) : "";

if (!connectionString) {
    console.error("Missing NEON_DATABASE_URL (or DATABASE_URL) in environment.");
    process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const tables = [
    "organizations",
    "users",
    "organization_users",
    "organization_invites",
    "organization_audit_logs",
    "campaigns",
    "signal_reports",
    "stripe_webhook_events",
    "subscriptions",
];

const neonSchema = "campaign_signal";

try {
    for (const table of tables) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${neonSchema}.${table}`);
        console.log(`${table}: ${rows[0].count}`);
    }
} catch (error) {
    console.error("Neon verify failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
