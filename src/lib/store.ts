import { CHALLENGES, createGeneratedImageUrl, getPromptPersona, scorePrompt } from "./engine";
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_SESSION_ID,
  loadStoreFromDisk,
  PromptWarsSessionStore,
  PromptWarsStore,
  saveStoreToDisk,
  saveStoreToDatabase,
} from "./persistence";
import { PlayerSubmission } from "./types";

const CHALLENGE_ROTATION_MS = 20 * 60 * 1000;
const SESSION_WINDOW_MS = 20 * 60 * 1000;

declare global {
  var __promptWarsStore: PromptWarsStore | undefined;
}

const store: PromptWarsStore =
  globalThis.__promptWarsStore ?? loadStoreFromDisk();

if (!globalThis.__promptWarsStore) {
  globalThis.__promptWarsStore = store;
}

function persistStore() {
  saveStoreToDisk(store);
  saveStoreToDatabase(store).catch((err) => console.error("DB persist error:", err));
}

export function overrideStore(newStore: PromptWarsStore) {
  Object.assign(store, newStore);
}

function sanitizeSessionId(sessionId?: string) {
  const id = (sessionId ?? store.defaultSessionId ?? DEFAULT_SESSION_ID).trim().toLowerCase();
  return id || DEFAULT_SESSION_ID;
}

function ensureSession(sessionId?: string): PromptWarsSessionStore {
  const id = sanitizeSessionId(sessionId);
  const existing = store.sessions[id];
  if (existing) {
    maybeRotateSessionWindow(existing);
    return existing;
  }

  const created: PromptWarsSessionStore = {
    id,
    createdAt: new Date().toISOString(),
    maxPlayers: DEFAULT_MAX_PLAYERS,
    lastChallengeRotationAt: new Date().toISOString(),
    currentChallengeIndex: 0,
    submissions: [],
    pendingSubmissions: [],
  };

  store.sessions[id] = created;
  persistStore();
  return created;
}

function maybeRotateSessionWindow(session: PromptWarsSessionStore) {
  const startedAt = Date.parse(session.createdAt);
  const now = Date.now();

  if (Number.isNaN(startedAt)) {
    session.createdAt = new Date(now).toISOString();
    persistStore();
    return;
  }

  if (now - startedAt < SESSION_WINDOW_MS) {
    return;
  }

  session.createdAt = new Date(now).toISOString();
  session.lastChallengeRotationAt = new Date(now).toISOString();
  session.submissions = [];
  session.pendingSubmissions = [];
  persistStore();
}

function getAllSessions() {
  return Object.values(store.sessions);
}

export function createSession(sessionId?: string) {
  const session = ensureSession(sessionId);
  return {
    sessionId: session.id,
    maxPlayers: session.maxPlayers,
    createdAt: session.createdAt,
  };
}

export function getSessionSummary(sessionId?: string) {
  const session = ensureSession(sessionId);
  return {
    sessionId: session.id,
    maxPlayers: session.maxPlayers,
    currentPlayers: getCurrentPlayerCount(session.id),
    finalizedSubmissions: session.submissions.length,
    pendingSubmissions: session.pendingSubmissions.length,
  };
}

function maybeAutoRotateChallenge(session: PromptWarsSessionStore) {
  const last = Date.parse(session.lastChallengeRotationAt);
  const now = Date.now();

  if (Number.isNaN(last)) {
    session.lastChallengeRotationAt = new Date(now).toISOString();
    persistStore();
    return;
  }

  if (now - last < CHALLENGE_ROTATION_MS) {
    return;
  }

  const steps = Math.max(1, Math.floor((now - last) / CHALLENGE_ROTATION_MS));
  session.currentChallengeIndex = (session.currentChallengeIndex + steps) % CHALLENGES.length;
  session.lastChallengeRotationAt = new Date(now).toISOString();
  persistStore();
}

export function getCurrentChallenge(sessionId?: string) {
  const session = ensureSession(sessionId);
  maybeAutoRotateChallenge(session);
  return CHALLENGES[session.currentChallengeIndex % CHALLENGES.length];
}

export function rotateChallenge(sessionId?: string) {
  const session = ensureSession(sessionId);
  session.currentChallengeIndex = (session.currentChallengeIndex + 1) % CHALLENGES.length;
  session.lastChallengeRotationAt = new Date().toISOString();
  persistStore();
  return getCurrentChallenge(session.id);
}

export function startNextBatch(sessionId?: string) {
  const session = ensureSession(sessionId);
  const now = new Date().toISOString();

  session.currentChallengeIndex = (session.currentChallengeIndex + 1) % CHALLENGES.length;
  session.createdAt = now;
  session.lastChallengeRotationAt = now;
  session.submissions = [];
  session.pendingSubmissions = [];

  persistStore();
  return getCurrentChallenge(session.id);
}

export function getSubmissions(sessionId?: string) {
  const session = ensureSession(sessionId);
  return [...session.submissions].sort((a, b) => b.scores.finalScore - a.scores.finalScore);
}

export function getPendingSubmissionById(id: string, sessionId?: string) {
  if (sessionId) {
    const session = ensureSession(sessionId);
    return session.pendingSubmissions.find((submission) => submission.id === id) ?? null;
  }

  for (const session of getAllSessions()) {
    const found = session.pendingSubmissions.find((submission) => submission.id === id);
    if (found) {
      return found;
    }
  }

  return null;
}

export function getRecentSubmissions(limit = 4, sessionId?: string) {
  const session = ensureSession(sessionId);
  return session.submissions.slice(0, limit);
}

export function getRecentPendingSubmissions(limit = 4, sessionId?: string) {
  const session = ensureSession(sessionId);
  return session.pendingSubmissions.slice(0, limit);
}

export function getSubmissionById(id: string, sessionId?: string) {
  if (sessionId) {
    const session = ensureSession(sessionId);
    return session.submissions.find((submission) => submission.id === id) ?? null;
  }

  for (const session of getAllSessions()) {
    const found = session.submissions.find((submission) => submission.id === id);
    if (found) {
      return found;
    }
  }

  return null;
}

export function getPlayerSubmissionCount(playerName: string, sessionId?: string) {
  const session = ensureSession(sessionId);
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  return session.submissions.filter(
    (submission) => submission.playerName.trim().toLowerCase() === normalized,
  ).length;
}

export function getCurrentPlayerCount(sessionId?: string) {
  const session = ensureSession(sessionId);
  const players = new Set<string>();
  for (const submission of session.submissions) {
    players.add(submission.playerName.trim().toLowerCase());
  }
  for (const submission of session.pendingSubmissions) {
    players.add(submission.playerName.trim().toLowerCase());
  }
  return players.size;
}

export function isSessionAtCapacity(sessionId?: string) {
  const session = ensureSession(sessionId);
  return getCurrentPlayerCount(session.id) >= session.maxPlayers;
}

export function createPendingSubmission(input: {
  id?: string;
  sessionId?: string;
  playerName: string;
  prompt: string;
  generatedImageUrl?: string;
  imageSimilarity?: number;
  forceZeroScore?: boolean;
}) {
  const session = ensureSession(input.sessionId);
  const normalizedName = input.playerName.trim().toLowerCase();
  const existingPlayer =
    session.submissions.some((submission) => submission.playerName.trim().toLowerCase() === normalizedName) ||
    session.pendingSubmissions.some((submission) => submission.playerName.trim().toLowerCase() === normalizedName);

  if (!existingPlayer && isSessionAtCapacity(session.id)) {
    throw new Error(`Session ${session.id} reached the ${session.maxPlayers}-player limit.`);
  }

  const challenge = getCurrentChallenge(session.id);
  const generatedImageUrl =
    input.generatedImageUrl ?? createGeneratedImageUrl(input.prompt, challenge.id);
  let scores = scorePrompt(input.prompt, challenge, {
    imageSimilarity: input.imageSimilarity,
  });
  let persona = getPromptPersona(input.prompt, scores.finalScore);

  if (input.forceZeroScore) {
    scores = {
      similarity: 0,
      promptQuality: 0,
      styleAlignment: 0,
      detailCoverage: 0,
      finalScore: 0,
    };
    persona = getPromptPersona("", 0);
  }

  const submission: PlayerSubmission = {
    id: input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: session.id,
    playerName: input.playerName,
    prompt: input.prompt,
    challenge,
    generatedImageUrl,
    scores,
    persona,
    createdAt: new Date().toISOString(),
  };

  session.pendingSubmissions.unshift(submission);
  session.pendingSubmissions = session.pendingSubmissions.slice(0, 200);
  persistStore();
  return submission;
}

export function finalizePendingSubmission(id: string, sessionId?: string) {
  const session = sessionId ? ensureSession(sessionId) : undefined;
  const targetSessions = session ? [session] : getAllSessions();

  for (const targetSession of targetSessions) {
    const pendingIndex = targetSession.pendingSubmissions.findIndex(
      (submission) => submission.id === id,
    );

    if (pendingIndex === -1) {
      continue;
    }

    const [submission] = targetSession.pendingSubmissions.splice(pendingIndex, 1);
    targetSession.submissions.unshift(submission);
    targetSession.submissions = targetSession.submissions.slice(0, 80);
    persistStore();
    return submission;
  }

  return null;
}

export function updatePendingSubmissionScore(
  id: string,
  imageSimilarity: number,
  sessionId?: string,
): boolean {
  const targetSessions = sessionId ? [ensureSession(sessionId)] : getAllSessions();

  for (const session of targetSessions) {
    const submission = session.pendingSubmissions.find((s) => s.id === id);
    if (submission) {
      const newScores = scorePrompt(submission.prompt, submission.challenge, { imageSimilarity });
      submission.scores = newScores;
      submission.persona = getPromptPersona(submission.prompt, newScores.finalScore);
      persistStore();
      return true;
    }
  }

  return false;
}

/**
 * Called by the background Stable Horde task once the image is generated.
 * Updates both the generatedImageUrl and recalculates scores with imageSimilarity.
 * Searches BOTH pendingSubmissions AND finalized submissions so it works
 * regardless of whether the user has already completed the survey.
 */
export function updatePendingSubmissionImageAndScore(
  id: string,
  generatedImageUrl: string,
  imageSimilarity: number,
  sessionId?: string,
): boolean {
  const targetSessions = sessionId ? [ensureSession(sessionId)] : getAllSessions();

  for (const session of targetSessions) {
    // Check pending first
    const pending = session.pendingSubmissions.find((s) => s.id === id);
    if (pending) {
      pending.generatedImageUrl = generatedImageUrl;
      const newScores = scorePrompt(pending.prompt, pending.challenge, { imageSimilarity });
      pending.scores = newScores;
      pending.persona = getPromptPersona(pending.prompt, newScores.finalScore);
      persistStore();
      return true;
    }

    // Also check finalized — user may have completed survey before image was ready
    const finalized = session.submissions.find((s) => s.id === id);
    if (finalized) {
      finalized.generatedImageUrl = generatedImageUrl;
      const newScores = scorePrompt(finalized.prompt, finalized.challenge, { imageSimilarity });
      finalized.scores = newScores;
      finalized.persona = getPromptPersona(finalized.prompt, newScores.finalScore);
      persistStore();
      return true;
    }
  }

  return false;
}
