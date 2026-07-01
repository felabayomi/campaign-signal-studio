import "dotenv/config";
import { Pool } from "pg";
import { neonSchemaSql } from "./neon-schema-sql.mjs";

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

try {
    await pool.query(neonSchemaSql);
    console.log("Neon schema initialized successfully.");
} catch (error) {
    console.error("Failed to initialize Neon schema:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
