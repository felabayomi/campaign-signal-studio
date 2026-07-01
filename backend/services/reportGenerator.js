import OpenAI from "openai";
import { getElectionPredictorIntelligence } from "./electionPredictorIntel.js";

function toTitleCase(value) {
    return String(value || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLongDate(isoDate) {
    if (!isoDate) return null;
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

function contextCategoriesFromNotes(notes) {
    const categories = ["user notes"];
    const normalized = String(notes || "").toLowerCase();
    if (/(news|article|headline|press)/.test(normalized)) categories.push("news context");
    if (/(speech|debate|transcript|remarks)/.test(normalized)) categories.push("speech/debate context");
    return categories;
}

function buildLegacyIntelligenceSources(input, intelligence, confidenceLevel) {
    const epUsed = Boolean(
        intelligence?.enabled &&
        Array.isArray(intelligence.matches) &&
        intelligence.matches.length > 0,
    );

    const firstMatch = epUsed ? intelligence.matches[0] : null;
    const factorCategories = epUsed
        ? (firstMatch.relevantFactors || []).slice(0, 6).map((f) => toTitleCase(f))
        : [];

    const categories = [
        ...new Set([
            ...(epUsed ? ["electionpredictor race context", "candidate comparison factors"] : []),
            ...contextCategoriesFromNotes(input.contextNotes),
        ]),
    ];

    const sourceLines = epUsed
        ? [
            `ElectionPredictor race context: ${firstMatch.title}`,
            `Candidate comparison factors: ${factorCategories.length > 0 ? factorCategories.join(", ") : "Polling, Fundraising, Endorsements, Momentum"}`,
            "User-provided campaign notes",
            "Uploaded speech/debate/news content",
        ]
        : [
            "This report was generated from your campaign profile and submitted context only.",
            "No external race intelligence was used.",
        ];

    return {
        usedElectionPredictor: epUsed,
        matchingRaceName: firstMatch?.title || null,
        raceContext: firstMatch?.raceContext || null,
        contextCategories: categories,
        sourceLines,
        lastChecked: intelligence?.generatedAt || null,
        lastCheckedLabel: formatLongDate(intelligence?.generatedAt),
        confidenceLevel,
    };
}

function buildContractIntelligenceSources(input, intelligence) {
    const epUsed = Boolean(
        intelligence?.enabled &&
        Array.isArray(intelligence.matches) &&
        intelligence.matches.length > 0,
    );

    const matchedRaces = epUsed
        ? intelligence.matches
            .map((m) => String(m?.title || "").trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];

    return {
        userProvidedContext: Boolean(String(input?.contextNotes || "").trim()),
        electionPredictorUsed: epUsed,
        matchedRaces,
        categoriesUsed: contextCategoriesFromNotes(input?.contextNotes),
        lastCheckedAt: intelligence?.generatedAt || new Date().toISOString(),
    };
}

function deterministicSignalGenerator(input) {
    const now = new Date();
    const electionDate = input.electionDate ? new Date(input.electionDate) : null;
    const daysToElection = electionDate
        ? Math.max(1, Math.floor((electionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
        : 120;

    const context = input.contextNotes || "";
    const confidence = context.length > 120 ? "High" : context.length > 40 ? "Medium" : "Low";

    const raceSnapshot =
        "This race is currently shaped by practical local concerns and message discipline. Focus the next 30 days on repeatable contrasts that tie directly to voter cost and safety priorities.";
    const opponentWatch =
        "Watch for opponent attacks around feasibility, cost, and trust. Track language shifts after major events and prepare quick rebuttal blocks in advance.";
    const messageMemo =
        "Center your message on practical results: lower monthly pressure, safer neighborhoods, and accountable local leadership. Keep phrasing plain, specific, and repeated.";

    const contentIdeas = [
        `${input.location || "District"}: 3-point explainer carousel on top local pressure points.`,
        `${input.officeType || "Campaign"} short post: what changes in first 100 days.`,
        "Field clip recap featuring one real voter concern and your policy response.",
    ];

    const videoAngles = [
        "30-second values statement tied to one local issue.",
        "Candidate walk-and-talk at a recognizable neighborhood location.",
        "Myth-vs-fact rebuttal to the latest opponent claim.",
    ];

    const quoteGraphics = [
        "Practical leadership should lower pressure, not raise it.",
        "Families need results they can feel every month.",
        "Local problems need focused, local solutions.",
    ];

    const fundraisingCaptions = [
        "Help us keep this campaign voter-first. Chip in today.",
        "Your contribution powers field outreach this week.",
        "If this message matters to you, help us scale it now.",
    ];

    const rapidResponsePlan = [
        "Publish same-day rebuttal with 3 verifiable points.",
        "Distribute aligned talking points to staff and volunteers within 2 hours.",
        "Deploy one short video and one quote card within 6 hours.",
    ];

    return {
        title: `${input.raceName || "Campaign"} Signal Report`,
        confidence,
        raceSnapshot,
        opponentWatch,
        messageMemo,
        contentIdeas,
        videoAngles,
        quoteGraphics,
        fundraisingCaptions,
        rapidResponsePlan,
        complianceNote:
            "Campaign teams are responsible for legal review, disclaimer requirements, and final publication approval.",
        _meta: {
            daysToElection,
        },
    };
}

function normalizeList(items, min = 3, max = 5, fallback = []) {
    const normalized = Array.isArray(items)
        ? items.map((v) => String(v).trim()).filter(Boolean).slice(0, max)
        : [];

    if (normalized.length >= min) {
        return normalized;
    }

    const fallbackList = Array.isArray(fallback)
        ? fallback.map((v) => String(v).trim()).filter(Boolean).slice(0, max)
        : [];

    return fallbackList.length >= min ? fallbackList : fallbackList.concat(normalized).slice(0, max);
}

function normalizeGeneratedReport(report, input) {
    const deterministic = deterministicSignalGenerator(input);
    const confidence = ["High", "Medium", "Low"].includes(report.confidence)
        ? report.confidence
        : "Medium";

    const title = typeof report.title === "string" && report.title.trim()
        ? report.title.trim()
        : `${input.raceName || "Campaign"} Signal Report`;

    const raceSnapshot = typeof report.raceSnapshot === "string" && report.raceSnapshot.trim()
        ? report.raceSnapshot.trim()
        : deterministic.raceSnapshot;

    const opponentWatch = typeof report.opponentWatch === "string" && report.opponentWatch.trim()
        ? report.opponentWatch.trim()
        : deterministic.opponentWatch;

    const messageMemo = typeof report.messageMemo === "string" && report.messageMemo.trim()
        ? report.messageMemo.trim()
        : deterministic.messageMemo;

    const contentIdeas = normalizeList(report.contentIdeas, 3, 5, deterministic.contentIdeas);
    const videoAngles = normalizeList(report.videoAngles, 3, 5, deterministic.videoAngles);
    const quoteGraphics = normalizeList(report.quoteGraphics, 3, 5, deterministic.quoteGraphics);
    const fundraisingCaptions = normalizeList(report.fundraisingCaptions, 3, 5, deterministic.fundraisingCaptions);
    const rapidResponsePlan = normalizeList(report.rapidResponsePlan, 3, 5, deterministic.rapidResponsePlan);

    const complianceNote = typeof report.complianceNote === "string" && report.complianceNote.trim()
        ? report.complianceNote.trim()
        : deterministic.complianceNote;

    const summary = raceSnapshot;
    const keySignals = [opponentWatch, messageMemo, ...contentIdeas].slice(0, 5);
    const actions = [...rapidResponsePlan].slice(0, 5);

    return {
        title,
        confidence,
        raceSnapshot,
        opponentWatch,
        messageMemo,
        contentIdeas,
        videoAngles,
        quoteGraphics,
        fundraisingCaptions,
        rapidResponsePlan,
        complianceNote,
        summary,
        keySignals,
        actions,
    };
}

async function openAiSignalGenerator(input, options = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not configured");
    }

    const model = process.env.OPENAI_REPORT_MODEL || "gpt-4o-mini";
    const client = new OpenAI({ apiKey });
    const electionPredictorIntel = options.intelligence || await getElectionPredictorIntelligence(input);

    const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "campaign_signal_report",
                schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        title: { type: "string" },
                        confidence: { type: "string", enum: ["High", "Medium", "Low"] },
                        raceSnapshot: { type: "string" },
                        opponentWatch: { type: "string" },
                        messageMemo: { type: "string" },
                        contentIdeas: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 3,
                            maxItems: 5,
                        },
                        videoAngles: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 3,
                            maxItems: 5,
                        },
                        quoteGraphics: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 3,
                            maxItems: 5,
                        },
                        fundraisingCaptions: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 3,
                            maxItems: 5,
                        },
                        rapidResponsePlan: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 3,
                            maxItems: 5,
                        },
                        complianceNote: { type: "string" },
                    },
                    required: [
                        "title",
                        "confidence",
                        "raceSnapshot",
                        "opponentWatch",
                        "messageMemo",
                        "contentIdeas",
                        "videoAngles",
                        "quoteGraphics",
                        "fundraisingCaptions",
                        "rapidResponsePlan",
                        "complianceNote",
                    ],
                },
            },
        },
        messages: [
            {
                role: "system",
                content:
                    "You are a campaign strategy analyst. Return only valid JSON matching the schema. Keep outputs concrete and practical for campaign teams. Do not include explicit win-probability percentages.",
            },
            {
                role: "user",
                content: `Generate a campaign signal report using this profile:\n${JSON.stringify(input, null, 2)}\n\nElectionPredictor background intelligence (local):\n${JSON.stringify(electionPredictorIntel, null, 2)}`,
            },
        ],
        ...options.openAi,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("OpenAI returned an empty response");
    }

    const parsed = JSON.parse(content);
    const report = normalizeGeneratedReport(parsed, input);

    const intelligenceSources = buildContractIntelligenceSources(input, electionPredictorIntel);
    return {
        ...report,
        intelligenceSources,
        legacyIntelligenceSources: buildLegacyIntelligenceSources(input, electionPredictorIntel, report.confidence),
    };
}

export async function generateCampaignSignalReport(input, options = {}) {
    const fallbackToDeterministic = process.env.OPENAI_FALLBACK_TO_DETERMINISTIC !== "false";
    const defaultProvider = process.env.OPENAI_API_KEY ? "openai" : "deterministic";
    const provider = options.provider || process.env.REPORT_PROVIDER || defaultProvider;
    const useDeepIntelligence = options.useDeepIntelligence !== false;
    const intelligence = useDeepIntelligence
        ? await getElectionPredictorIntelligence(input)
        : {
            enabled: false,
            matches: [],
            generatedAt: null,
        };

    if (provider === "deterministic") {
        const report = deterministicSignalGenerator(input);
        const normalized = normalizeGeneratedReport(report, input);
        return {
            ...normalized,
            intelligenceSources: buildContractIntelligenceSources(input, intelligence),
            legacyIntelligenceSources: buildLegacyIntelligenceSources(input, intelligence, normalized.confidence),
        };
    }

    if (provider === "openai") {
        try {
            return await openAiSignalGenerator(input, { ...options, intelligence });
        } catch (error) {
            if (fallbackToDeterministic) {
                const report = deterministicSignalGenerator(input);
                const normalized = normalizeGeneratedReport(report, input);
                return {
                    ...normalized,
                    intelligenceSources: buildContractIntelligenceSources(input, intelligence),
                    legacyIntelligenceSources: buildLegacyIntelligenceSources(input, intelligence, normalized.confidence),
                };
            }
            throw error;
        }
    }

    throw new Error(`Unsupported report provider: ${provider}`);
}
