import "dotenv/config";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { neonSchemaSql } from "./neon-schema-sql.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sqlitePath = path.join(__dirname, "..", "data", "campaign-signal.db");
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

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const orderedTables = [
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

const syncTable = async (client, tableName) => {
    const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
    if (rows.length === 0) {
        return { tableName, count: 0 };
    }

    const columns = Object.keys(rows[0]);
    const quotedColumns = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

    const conflictTarget = tableName === "subscriptions" ? "id" : "id";
    const updateSet = columns
        .filter((c) => c !== conflictTarget)
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(", ");

    const upsertSql = `
        INSERT INTO ${neonSchema}.${tableName} (${quotedColumns})
    VALUES (${placeholders})
    ON CONFLICT (${conflictTarget})
    DO UPDATE SET ${updateSet}
  `;

    for (const row of rows) {
        const values = columns.map((col) => row[col]);
        await client.query(upsertSql, values);
    }

    return { tableName, count: rows.length };
};

try {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(neonSchemaSql);

        for (const tableName of orderedTables) {
            const result = await syncTable(client, tableName);
            console.log(`${result.tableName}: ${result.count}`);
        }

        await client.query("COMMIT");
        console.log("SQLite to Neon sync completed.");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
} catch (error) {
    console.error("Neon sync failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
    sqlite.close();
}
