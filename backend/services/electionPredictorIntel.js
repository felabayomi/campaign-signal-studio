import fs from "node:fs";
import path from "node:path";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = {
    loadedAt: 0,
    snapshot: null,
    snapshotPath: null,
};

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

function getBackupDirectory() {
    if (process.env.ELECTION_PREDICTOR_BACKUP_PATH) {
        return process.env.ELECTION_PREDICTOR_BACKUP_PATH;
    }

    // Default: C:\FelixPlatform\incoming\ElectionPredictor\ElectionPredictor\database\backups
    return path.resolve(
        process.cwd(),
        "..",
        "..",
        "incoming",
        "ElectionPredictor",
        "ElectionPredictor",
        "database",
        "backups",
    );
}

function getLatestBackupFile(backupDir) {
    if (!fs.existsSync(backupDir)) {
        return null;
    }

    const files = fs
        .readdirSync(backupDir)
        .filter((name) => name.startsWith("electionpredictor-ep-snapshot-") && name.endsWith(".json"))
        .map((name) => {
            const fullPath = path.join(backupDir, name);
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files[0]?.fullPath || null;
}

function loadSnapshot() {
    const now = Date.now();
    if (cache.snapshot && now - cache.loadedAt < CACHE_TTL_MS) {
        return { snapshot: cache.snapshot, snapshotPath: cache.snapshotPath };
    }

    const backupDir = getBackupDirectory();
    const backupFile = getLatestBackupFile(backupDir);
    if (!backupFile) {
        return { snapshot: null, snapshotPath: null };
    }

    const raw = fs.readFileSync(backupFile, "utf8");
    const parsed = JSON.parse(raw);

    cache = {
        loadedAt: now,
        snapshot: parsed,
        snapshotPath: backupFile,
    };

    return { snapshot: parsed, snapshotPath: backupFile };
}

function pickTopRaceMatches(races, input) {
    const office = normalize(input.officeType);
    const location = normalize(input.location);
    const raceName = normalize(input.raceName);

    const locationTokens = location.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const raceTokens = raceName.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);

    const scored = races.map((race) => {
        const title = normalize(race.title);
        const type = normalize(race.type);
        let score = 0;

        if (office && type.includes(office)) score += 5;
        if (location && title.includes(location)) score += 5;

        for (const token of locationTokens) {
            if (title.includes(token)) score += 1;
        }

        for (const token of raceTokens) {
            if (title.includes(token)) score += 1;
        }

        return { race, score };
    });

    return scored
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((entry) => entry.race);
}

function buildRaceIntelligence(matches, predictions, candidatesById) {
    return matches.map((race) => {
        const racePredictions = predictions
            .filter((p) => p.race_id === race.id)
            .sort((a, b) => (b.win_probability || 0) - (a.win_probability || 0))
            .slice(0, 3)
            .map((p) => {
                const candidate = candidatesById.get(p.candidate_id);
                return {
                    candidateName: candidate?.name || "Unknown candidate",
                    party: candidate?.party || "Unknown",
                    winProbability: p.win_probability,
                    confidenceLow: p.confidence_interval_low,
                    confidenceHigh: p.confidence_interval_high,
                    factors: p.factors || {},
                    lastUpdated: p.last_updated || null,
                };
            });

        let raceContext = "Limited race context";
        if (racePredictions.length >= 2) {
            const gap = (racePredictions[0].winProbability || 0) - (racePredictions[1].winProbability || 0);
            if (gap <= 5) raceContext = "Competitive race";
            else if (gap <= 12) raceContext = "Leaning race";
            else raceContext = "Clear advantage race";
        } else if (racePredictions.length === 1) {
            raceContext = "Single front-runner context";
        }

        const relevantFactors = new Set();
        for (const pred of racePredictions) {
            for (const key of Object.keys(pred.factors || {})) {
                relevantFactors.add(key);
            }
        }

        return {
            raceId: race.id,
            title: race.title,
            type: race.type,
            electionDate: race.election_date || null,
            raceContext,
            relevantFactors: Array.from(relevantFactors),
            hasCandidateComparisons: racePredictions.length > 0,
            sourceUpdatedAt: racePredictions[0]?.lastUpdated || null,
        };
    });
}

function buildSummary(intelRows) {
    if (intelRows.length === 0) {
        return "No relevant ElectionPredictor race matches found in local snapshot.";
    }

    const lines = intelRows.map((row) => {
        if (!row.hasCandidateComparisons) {
            return `- ${row.title}: no candidate probability records available.`;
        }

        const factors = row.relevantFactors.length > 0 ? row.relevantFactors.join(", ") : "limited factor data";
        return `- ${row.title}: ${row.raceContext}. Relevant factors include ${factors}.`;
    });

    return lines.join("\n");
}

export async function getElectionPredictorIntelligence(input) {
    const enabled = process.env.ELECTION_PREDICTOR_INTEL_ENABLED !== "false";
    if (!enabled) {
        return {
            enabled: false,
            summary: "ElectionPredictor intelligence disabled via environment.",
            sourcePath: null,
            generatedAt: null,
            matches: [],
            categories: [],
        };
    }

    try {
        const { snapshot, snapshotPath } = loadSnapshot();
        if (!snapshot?.tables) {
            return {
                enabled: true,
                summary: "ElectionPredictor snapshot unavailable.",
                sourcePath: snapshotPath,
                generatedAt: null,
                matches: [],
                categories: [],
            };
        }

        const races = Array.isArray(snapshot.tables.ep_races) ? snapshot.tables.ep_races : [];
        const candidates = Array.isArray(snapshot.tables.ep_candidates) ? snapshot.tables.ep_candidates : [];
        const predictions = Array.isArray(snapshot.tables.ep_predictions) ? snapshot.tables.ep_predictions : [];

        const candidatesById = new Map(candidates.map((c) => [c.id, c]));
        const matches = pickTopRaceMatches(races, input);
        const raceIntel = buildRaceIntelligence(matches, predictions, candidatesById);

        return {
            enabled: true,
            summary: buildSummary(raceIntel),
            sourcePath: snapshotPath,
            generatedAt: snapshot.generatedAt || null,
            matches: raceIntel,
            categories: ["polling", "fundraising", "endorsements", "momentum"],
        };
    } catch (error) {
        return {
            enabled: true,
            summary: `ElectionPredictor intelligence unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
            sourcePath: null,
            generatedAt: null,
            matches: [],
            categories: [],
        };
    }
}
