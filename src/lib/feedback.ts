import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { SubmissionEvent, SurveyFeedback } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const FEEDBACK_FILE = path.join(DATA_DIR, "promptwars-feedback.csv");
const SUBMISSION_FILE = path.join(DATA_DIR, "promptwars-submissions.csv");

let pool: Pool | null = null;
let poolConnectionString: string | null = null;
let feedbackTableReady = false;
let submissionTableReady = false;
let feedbackColumnsCache: Set<string> | null = null;

function getFeedbackStorageMode(): "postgres" | "csv" {
  const mode = (process.env.FEEDBACK_STORAGE ?? "auto").trim().toLowerCase();

  if (mode === "csv") {
    return "csv";
  }

  if (mode === "postgres") {
    return "postgres";
  }

  return resolveDatabaseUrl() ? "postgres" : "csv";
}

function canFallbackToCsv() {
  if (process.env.STRICT_POSTGRES_WRITES === "true") {
    return false;
  }

  if (process.env.ALLOW_CSV_FALLBACK === "false") {
    return false;
  }

  return true;
}

function resolveDatabaseUrl(): string | undefined {
  const onlineUrl = process.env.ONLINE_DATABASE_URL?.trim();
  const localUrl = process.env.LOCAL_DATABASE_URL?.trim();
  const fallbackUrl = process.env.DATABASE_URL?.trim();

  if (process.env.NODE_ENV === "production") {
    return onlineUrl || fallbackUrl;
  }

  return localUrl || fallbackUrl;
}

export function getPool() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    throw new Error(
      "LOCAL_DATABASE_URL/ONLINE_DATABASE_URL (or DATABASE_URL fallback) is required when FEEDBACK_STORAGE is postgres.",
    );
  }

  if (!pool || poolConnectionString !== databaseUrl) {
    if (pool) {
      void pool.end().catch(() => undefined);
    }

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });

    poolConnectionString = databaseUrl;
    feedbackTableReady = false;
    submissionTableReady = false;
    feedbackColumnsCache = null;
  }

  return pool;
}

async function ensureFeedbackTable() {
  if (feedbackTableReady) {
    return;
  }

  const client = await getPool().connect();
  try {
    const runBestEffort = async (query: string) => {
      try {
        await client.query(query);
      } catch (error) {
        console.warn("survey_feedback schema sync warning", error);
      }
    };

    await runBestEffort(`
      CREATE TABLE IF NOT EXISTS survey_feedback (
        id BIGSERIAL PRIMARY KEY,
        submitted_at TIMESTAMPTZ NOT NULL,
        game_id TEXT NOT NULL DEFAULT 'main',
        submission_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        challenge_title TEXT NOT NULL,
        submitted_prompt TEXT NOT NULL DEFAULT '',
        final_score INTEGER NOT NULL,
        prompt_length INTEGER NOT NULL,
        app_uses_by_player INTEGER NOT NULL,
        applications_used JSONB NOT NULL DEFAULT '[]'::jsonb,
        works_well_aspects JSONB NOT NULL DEFAULT '[]'::jsonb,
        improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
        works_well_other TEXT,
        improvement_other TEXT,
        additional_feedback TEXT NOT NULL DEFAULT ''
      )
    `);

    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS game_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS room_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'main'`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS submitted_prompt TEXT NOT NULL DEFAULT ''`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS applications_used JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_aspects JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS works_well_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvement_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS additional_feedback TEXT NOT NULL DEFAULT ''`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS apps_used TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS aspects_well TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS aspects_well_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvements_needed TEXT[] NOT NULL DEFAULT '{}'::text[]`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS improvements_other TEXT`,
    );
    await runBestEffort(
      `ALTER TABLE survey_feedback ADD COLUMN IF NOT EXISTS additional_suggestions TEXT`,
    );

    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_submission_id ON survey_feedback(submission_id)`,
    );
    try {
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_feedback_submission_id ON survey_feedback(submission_id)`,
      );
    } catch (error) {
      // Older hosted datasets can contain duplicate submission_id values.
      // Keep writes working by falling back to delete+insert idempotency.
      console.warn("Unable to create unique index uq_survey_feedback_submission_id", error);
    }
    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_player_name ON survey_feedback(player_name)`,
    );
    await runBestEffort(
      `CREATE INDEX IF NOT EXISTS idx_survey_feedback_game_id ON survey_feedback(game_id)`,
    );
    feedbackTableReady = true;
  } finally {
    client.release();
  }
}

async function getFeedbackColumns(): Promise<Set<string>> {
  if (feedbackColumnsCache) {
    return feedbackColumnsCache;
  }

  const result = await getPool().query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'survey_feedback'
    `,
  );

  feedbackColumnsCache = new Set(result.rows.map((row) => row.column_name));
  return feedbackColumnsCache;
}

async function ensureSubmissionTable() {
  if (submissionTableReady) {
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_submissions (
        id BIGSERIAL PRIMARY KEY,
        submitted_at TIMESTAMPTZ NOT NULL,
        game_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        challenge_title TEXT NOT NULL,
        submitted_prompt TEXT NOT NULL,
        generated_image_url TEXT NOT NULL
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_game_submissions_game_id ON game_submissions(game_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_game_submissions_submission_id ON game_submissions(submission_id)`,
    );
    submissionTableReady = true;
  } finally {
    client.release();
  }
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function escapeCsv(value: string | number | boolean): string {
  const text = String(value).replace(/\r?\n/g, " ").trim();
  if (text.includes(",") || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function ensureHeader() {
  if (existsSync(FEEDBACK_FILE)) {
    return;
  }

  const header = [
    "submittedAt",
    "gameId",
    "submissionId",
    "playerName",
    "challengeId",
    "challengeTitle",
    "submittedPrompt",
    "finalScore",
    "promptLength",
    "appUsesByPlayer",
    "applicationsUsed",
    "worksWellAspects",
    "improvementAreas",
    "worksWellOther",
    "improvementOther",
    "additionalFeedback",
  ].join(",");

  writeFileSync(FEEDBACK_FILE, `${header}\n`, "utf-8");
}

function ensureSubmissionHeader() {
  if (existsSync(SUBMISSION_FILE)) {
    return;
  }

  const header = [
    "submittedAt",
    "gameId",
    "submissionId",
    "playerName",
    "challengeId",
    "challengeTitle",
    "submittedPrompt",
    "generatedImageUrl",
  ].join(",");

  writeFileSync(SUBMISSION_FILE, `${header}\n`, "utf-8");
}

export function saveFeedbackToCsv(feedback: SurveyFeedback) {
  ensureDataDir();
  ensureHeader();

  const row = [
    feedback.submittedAt,
    feedback.gameId,
    feedback.submissionId,
    feedback.playerName,
    feedback.challengeId,
    feedback.challengeTitle,
    feedback.submittedPrompt,
    feedback.finalScore,
    feedback.promptLength,
    feedback.appUsesByPlayer,
    JSON.stringify(feedback.applicationsUsed),
    JSON.stringify(feedback.worksWellAspects),
    JSON.stringify(feedback.improvementAreas),
    feedback.worksWellOther ?? "",
    feedback.improvementOther ?? "",
    feedback.additionalFeedback,
  ]
    .map(escapeCsv)
    .join(",");

  appendFileSync(FEEDBACK_FILE, `${row}\n`, "utf-8");
}

export type StoredFeedbackEntry = {
  id?: number;
  submittedAt: string;
  gameId: string;
  submissionId: string;
  playerName: string;
  challengeId: string;
  challengeTitle: string;
  submittedPrompt: string;
  finalScore: number;
  promptLength: number;
  appUsesByPlayer: number;
  applicationsUsed: string[];
  worksWellAspects: string[];
  improvementAreas: string[];
  worksWellOther: string;
  improvementOther: string;
  additionalFeedback: string;
  storage: "postgres" | "csv";
};

export type StoredFeedbackResponse = {
  storageMode: "postgres" | "csv";
  entries: StoredFeedbackEntry[];
  fallbackReason?: string;
};

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [trimmed];
    }
  }

  return [];
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readFeedbackFromCsv(limit: number, sessionId?: string): StoredFeedbackEntry[] {
  if (!existsSync(FEEDBACK_FILE)) {
    return [];
  }

  const content = readFileSync(FEEDBACK_FILE, "utf-8").trim();
  if (!content) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  if (lines.length <= 1) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const headerIndex = new Map(header.map((key, index) => [key, index]));

  const getValue = (row: string[], key: string) => {
    const index = headerIndex.get(key);
    if (index === undefined) {
      return "";
    }
    return row[index] ?? "";
  };

  const entries = lines
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseCsvLine(line))
    .map((row) => {
      const gameId = getValue(row, "gameId") || "main";
      return {
        submittedAt: getValue(row, "submittedAt"),
        gameId,
        submissionId: getValue(row, "submissionId"),
        playerName: getValue(row, "playerName"),
        challengeId: getValue(row, "challengeId"),
        challengeTitle: getValue(row, "challengeTitle"),
        submittedPrompt: getValue(row, "submittedPrompt"),
        finalScore: Number(getValue(row, "finalScore") || 0),
        promptLength: Number(getValue(row, "promptLength") || 0),
        appUsesByPlayer: Number(getValue(row, "appUsesByPlayer") || 0),
        applicationsUsed: toStringArray(getValue(row, "applicationsUsed")),
        worksWellAspects: toStringArray(getValue(row, "worksWellAspects")),
        improvementAreas: toStringArray(getValue(row, "improvementAreas")),
        worksWellOther: getValue(row, "worksWellOther"),
        improvementOther: getValue(row, "improvementOther"),
        additionalFeedback: getValue(row, "additionalFeedback"),
        storage: "csv" as const,
      };
    })
    .filter((entry) => !sessionId || entry.gameId === sessionId)
    .reverse()
    .slice(0, limit);

  return entries;
}

export async function getFeedbackEntries(options?: {
  sessionId?: string;
  limit?: number;
}): Promise<StoredFeedbackResponse> {
  const requestedLimit = options?.limit ?? 1000;
  const limit = Math.max(1, Math.min(requestedLimit, 5000));
  const sessionId = options?.sessionId?.trim().toLowerCase();
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    return {
      storageMode: "csv",
      entries: readFeedbackFromCsv(limit, sessionId),
    };
  }

  try {
    await ensureFeedbackTable();
    feedbackColumnsCache = null;
    const columns = await getFeedbackColumns();

    const params: unknown[] = [];
    let whereClause = "";

    if (sessionId) {
      const sessionColumn = columns.has("session_id")
        ? "session_id"
        : columns.has("room_id")
          ? "room_id"
          : columns.has("game_id")
            ? "game_id"
            : null;

      if (sessionColumn) {
        params.push(sessionId);
        whereClause = `WHERE ${sessionColumn} = $1`;
      }
    }

    params.push(limit);
    const limitParam = `$${params.length}`;

    const result = await getPool().query<Record<string, unknown>>(
      `
        SELECT *
        FROM survey_feedback
        ${whereClause}
        ORDER BY id DESC
        LIMIT ${limitParam}
      `,
      params,
    );

    const entries: StoredFeedbackEntry[] = result.rows.map((row) => ({
      id: typeof row.id === "number" ? row.id : Number(row.id ?? 0) || undefined,
      submittedAt:
        row.submitted_at instanceof Date
          ? row.submitted_at.toISOString()
          : String(row.submitted_at ?? new Date().toISOString()),
      gameId: String(row.session_id ?? row.room_id ?? row.game_id ?? "main"),
      submissionId: String(row.submission_id ?? ""),
      playerName: String(row.player_name ?? ""),
      challengeId: String(row.challenge_id ?? ""),
      challengeTitle: String(row.challenge_title ?? ""),
      submittedPrompt: String(row.submitted_prompt ?? ""),
      finalScore: Number(row.final_score ?? 0),
      promptLength: Number(row.prompt_length ?? 0),
      appUsesByPlayer: Number(row.app_uses_by_player ?? 0),
      applicationsUsed: toStringArray(row.applications_used ?? row.apps_used),
      worksWellAspects: toStringArray(row.works_well_aspects ?? row.aspects_well),
      improvementAreas: toStringArray(row.improvement_areas ?? row.improvements_needed),
      worksWellOther: String(row.works_well_other ?? row.aspects_well_other ?? ""),
      improvementOther: String(row.improvement_other ?? row.improvements_other ?? ""),
      additionalFeedback: String(row.additional_feedback ?? row.additional_suggestions ?? ""),
      storage: "postgres",
    }));

    return {
      storageMode: "postgres",
      entries,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unable to read feedback from postgres.";
    return {
      storageMode: "csv",
      entries: readFeedbackFromCsv(limit, sessionId),
      fallbackReason: reason,
    };
  }
}

export function saveSubmissionToCsv(submission: SubmissionEvent) {
  ensureDataDir();
  ensureSubmissionHeader();

  const row = [
    submission.submittedAt,
    submission.gameId,
    submission.submissionId,
    submission.playerName,
    submission.challengeId,
    submission.challengeTitle,
    submission.submittedPrompt,
    submission.generatedImageUrl,
  ]
    .map(escapeCsv)
    .join(",");

  appendFileSync(SUBMISSION_FILE, `${row}\n`, "utf-8");
}

export async function saveSubmissionEvent(submission: SubmissionEvent) {
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    saveSubmissionToCsv(submission);
    return;
  }

  await ensureSubmissionTable();
  await getPool().query(
    `
      INSERT INTO game_submissions (
        submitted_at,
        game_id,
        submission_id,
        player_name,
        challenge_id,
        challenge_title,
        submitted_prompt,
        generated_image_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
    `,
    [
      submission.submittedAt,
      submission.gameId,
      submission.submissionId,
      submission.playerName,
      submission.challengeId,
      submission.challengeTitle,
      submission.submittedPrompt,
      submission.generatedImageUrl,
    ],
  );
}

export async function saveFeedback(feedback: SurveyFeedback) {
  const mode = getFeedbackStorageMode();

  if (mode === "csv") {
    saveFeedbackToCsv(feedback);
    return;
  }

  const fallbackOrThrow = (context: string, error?: unknown) => {
    if (canFallbackToCsv()) {
      console.error(`${context}, falling back to CSV`, error);
      saveFeedbackToCsv(feedback);
      return;
    }

    const message = error instanceof Error ? `${context}: ${error.message}` : context;
    throw new Error(message);
  };

  try {
    await ensureFeedbackTable();
  } catch (error) {
    fallbackOrThrow("saveFeedback: ensureFeedbackTable failed", error);
    return;
  }
  feedbackColumnsCache = null;

  let columns: Set<string>;
  try {
    columns = await getFeedbackColumns();
  } catch (error) {
    fallbackOrThrow("saveFeedback: getFeedbackColumns failed", error);
    return;
  }

  if (!columns.has("submission_id")) {
    fallbackOrThrow("saveFeedback: submission_id column missing");
    return;
  }

  const values: unknown[] = [];
  const valueExpressions: string[] = [];
  const insertColumns: string[] = [];

  const pushValue = (column: string, value: unknown, cast?: string) => {
    if (!columns.has(column)) {
      return;
    }

    values.push(value);
    const index = values.length;
    valueExpressions.push(cast ? `$${index}::${cast}` : `$${index}`);
    insertColumns.push(column);
  };

  pushValue("submitted_at", feedback.submittedAt);
  pushValue("game_id", feedback.gameId);
  pushValue("room_id", feedback.gameId);
  pushValue("session_id", feedback.gameId);
  pushValue("submission_id", feedback.submissionId);
  pushValue("player_name", feedback.playerName);
  pushValue("challenge_id", feedback.challengeId);
  pushValue("challenge_title", feedback.challengeTitle);
  pushValue("submitted_prompt", feedback.submittedPrompt);
  pushValue("final_score", feedback.finalScore);
  pushValue("prompt_length", feedback.promptLength);
  pushValue("app_uses_by_player", feedback.appUsesByPlayer);
  pushValue("applications_used", JSON.stringify(feedback.applicationsUsed), "jsonb");
  pushValue("works_well_aspects", JSON.stringify(feedback.worksWellAspects), "jsonb");
  pushValue("improvement_areas", JSON.stringify(feedback.improvementAreas), "jsonb");
  pushValue("works_well_other", feedback.worksWellOther ?? null);
  pushValue("improvement_other", feedback.improvementOther ?? null);
  pushValue("additional_feedback", feedback.additionalFeedback);
  pushValue("apps_used", feedback.applicationsUsed, "text[]");
  pushValue("aspects_well", feedback.worksWellAspects, "text[]");
  pushValue("aspects_well_other", feedback.worksWellOther ?? null);
  pushValue("improvements_needed", feedback.improvementAreas, "text[]");
  pushValue("improvements_other", feedback.improvementOther ?? null);
  pushValue("additional_suggestions", feedback.additionalFeedback || null);

  if (insertColumns.length === 0) {
    fallbackOrThrow("saveFeedback: no writable columns");
    return;
  }

  try {
    await getPool().query(`DELETE FROM survey_feedback WHERE submission_id = $1`, [feedback.submissionId]);

    await getPool().query(
      `
        INSERT INTO survey_feedback (${insertColumns.join(", ")})
        VALUES (${valueExpressions.join(", ")})
      `,
      values,
    );
  } catch (error) {
    fallbackOrThrow("saveFeedback: postgres insert failed", error);
  }
}
