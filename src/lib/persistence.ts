import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPool } from "./feedback";
import { PlayerSubmission } from "./types";

export const DEFAULT_SESSION_ID = "main";
export const DEFAULT_MAX_PLAYERS = 20;

export type PromptWarsSessionStore = {
  id: string;
  createdAt: string;
  maxPlayers: number;
  lastChallengeRotationAt: string;
  currentChallengeIndex: number;
  submissions: PlayerSubmission[];
  pendingSubmissions: PlayerSubmission[];
};

export type PromptWarsStore = {
  defaultSessionId: string;
  sessions: Record<string, PromptWarsSessionStore>;
};

type LegacyStore = {
  currentChallengeIndex: number;
  submissions: PlayerSubmission[];
  pendingSubmissions?: PlayerSubmission[];
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "promptwars-store.json");
const TEMP_FILE = path.join(DATA_DIR, "promptwars-store.tmp.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultStore(): PromptWarsStore {
  const defaultSession: PromptWarsSessionStore = {
    id: DEFAULT_SESSION_ID,
    createdAt: new Date().toISOString(),
    maxPlayers: DEFAULT_MAX_PLAYERS,
    lastChallengeRotationAt: new Date().toISOString(),
    currentChallengeIndex: 0,
    submissions: [],
    pendingSubmissions: [],
  };

  return {
    defaultSessionId: DEFAULT_SESSION_ID,
    sessions: {
      [DEFAULT_SESSION_ID]: defaultSession,
    },
  };
}

function isStoreShape(value: unknown): value is PromptWarsStore {
  const candidate = value as Partial<PromptWarsStore>;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.defaultSessionId === "string" &&
    typeof candidate.sessions === "object" &&
    candidate.sessions !== null
  );
}

function isLegacyStoreShape(value: unknown): value is LegacyStore {
  const candidate = value as Partial<LegacyStore>;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.currentChallengeIndex === "number" &&
    Array.isArray(candidate.submissions)
  );
}

function normalizeSession(id: string, value: unknown): PromptWarsSessionStore | null {
  const candidate = value as Partial<PromptWarsSessionStore>;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.currentChallengeIndex !== "number" ||
    !Array.isArray(candidate.submissions)
  ) {
    return null;
  }

  return {
    id,
    createdAt:
      typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
    maxPlayers:
      typeof candidate.maxPlayers === "number" && candidate.maxPlayers > 0
        ? candidate.maxPlayers
        : DEFAULT_MAX_PLAYERS,
    lastChallengeRotationAt:
      typeof candidate.lastChallengeRotationAt === "string"
        ? candidate.lastChallengeRotationAt
        : new Date().toISOString(),
    currentChallengeIndex: candidate.currentChallengeIndex,
    submissions: candidate.submissions,
    pendingSubmissions: Array.isArray(candidate.pendingSubmissions)
      ? candidate.pendingSubmissions
      : [],
  };
}

function migrateLegacyStore(legacy: LegacyStore): PromptWarsStore {
  return {
    defaultSessionId: DEFAULT_SESSION_ID,
    sessions: {
      [DEFAULT_SESSION_ID]: {
        id: DEFAULT_SESSION_ID,
        createdAt: new Date().toISOString(),
        maxPlayers: DEFAULT_MAX_PLAYERS,
        lastChallengeRotationAt: new Date().toISOString(),
        currentChallengeIndex: legacy.currentChallengeIndex,
        submissions: legacy.submissions,
        pendingSubmissions: Array.isArray(legacy.pendingSubmissions)
          ? legacy.pendingSubmissions
          : [],
      },
    },
  };
}

export function loadStoreFromDisk(): PromptWarsStore {
  ensureDataDir();

  if (!existsSync(DATA_FILE)) {
    return defaultStore();
  }

  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (isLegacyStoreShape(parsed)) {
      return migrateLegacyStore(parsed);
    }

    if (!isStoreShape(parsed)) {
      return defaultStore();
    }

    const normalizedSessions = Object.entries(parsed.sessions)
      .map(([id, session]) => [id, normalizeSession(id, session)] as const)
      .filter(([, session]) => session !== null);

    if (normalizedSessions.length === 0) {
      return defaultStore();
    }

    const sessions = Object.fromEntries(normalizedSessions) as Record<string, PromptWarsSessionStore>;
    const defaultSessionId = sessions[parsed.defaultSessionId]
      ? parsed.defaultSessionId
      : Object.keys(sessions)[0];

    return {
      defaultSessionId,
      sessions,
    };
  } catch {
    return defaultStore();
  }
}

export function saveStoreToDisk(store: PromptWarsStore) {
  ensureDataDir();

  const serialized = JSON.stringify(store, null, 2);
  writeFileSync(TEMP_FILE, serialized, "utf-8");

  if (existsSync(DATA_FILE)) {
    unlinkSync(DATA_FILE);
  }

  renameSync(TEMP_FILE, DATA_FILE);
}

// === DATABASE PERSISTENCE ===

let gameStateTableReady = false;

async function ensureGameStateTable() {
  if (gameStateTableReady) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    gameStateTableReady = true;
  } finally {
    client.release();
  }
}

export async function loadStoreFromDatabase(): Promise<PromptWarsStore | null> {
  try {
    if (!process.env.DATABASE_URL) return null;
    await ensureGameStateTable();
    
    const result = await getPool().query(`SELECT state FROM game_state WHERE id = 1`);
    if (result.rows.length === 0) return null;
    
    const parsed = result.rows[0].state;
    
    if (isLegacyStoreShape(parsed)) {
      return migrateLegacyStore(parsed);
    }
    
    if (!isStoreShape(parsed)) {
      return null;
    }
    
    const normalizedSessions = Object.entries(parsed.sessions)
      .map(([id, session]) => [id, normalizeSession(id, session)] as const)
      .filter(([, session]) => session !== null);

    if (normalizedSessions.length === 0) {
      return null;
    }

    const sessions = Object.fromEntries(normalizedSessions) as Record<string, PromptWarsSessionStore>;
    const defaultSessionId = sessions[parsed.defaultSessionId]
      ? parsed.defaultSessionId
      : Object.keys(sessions)[0];

    return {
      defaultSessionId,
      sessions,
    };
  } catch (error) {
    console.error("Failed to load store from Postgres:", error);
    return null;
  }
}

export async function saveStoreToDatabase(store: PromptWarsStore) {
  try {
    if (!process.env.DATABASE_URL) return;
    await ensureGameStateTable();
    
    await getPool().query(
      `INSERT INTO game_state (id, state, updated_at) 
       VALUES (1, $1, NOW()) 
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(store)]
    );
  } catch (error) {
    console.error("Failed to save store to Postgres:", error);
  }
}
