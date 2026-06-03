import "dotenv/config";
import cors from "cors";
import express from "express";
import { createGeneratedImageUrl } from "./lib/engine";
import { compareTargetUrlWithBuffer } from "./lib/imageSimilarity";
import { generateImage, getCachedImage } from "./lib/huggingface";
import { getFeedbackEntries, saveFeedback, saveSubmissionEvent } from "./lib/feedback";
import {
  createSession,
  createPendingSubmission,
  finalizePendingSubmission,
  getCurrentChallenge,
  getCurrentPlayerCount,
  getPendingSubmissionById,
  getPlayerSubmissionCount,
  getRecentPendingSubmissions,
  getRecentSubmissions,
  getSessionSummary,
  startNextBatch,
  getSubmissionById,
  getSubmissions,
  isSessionAtCapacity,
  rotateChallenge,
  updatePendingSubmissionScore,
  updatePendingSubmissionImageAndScore,
} from "./lib/store";
import { SurveyFeedback } from "./lib/types";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendUrl =
  process.env.FRONTEND_URL ?? "https://prompt-war-six.vercel.app";
// Backend's own public URL — used to build /api/image/:id URLs
const backendUrl =
  process.env.RENDER_EXTERNAL_URL ??
  process.env.BACKEND_URL ??
  `http://localhost:${port}`;

const allowedOrigins = new Set([
  frontendUrl,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://prompt-war-six.vercel.app",
]);

function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function shouldRunImageSimilarity() {
  if (process.env.DISABLE_IMAGE_SIMILARITY === "true") {
    return false;
  }

  return true;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin) || isLocalOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.options("*", cors());
app.use(express.json({ limit: "1mb" }));

function toAbsoluteUrl(maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) {
    return maybeRelative;
  }

  return new URL(maybeRelative, frontendUrl).toString();
}

function normalizeSessionId(raw?: string): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function getSessionIdFromRequest(req: express.Request): string | undefined {
  const querySession = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const headerSession = typeof req.headers["x-session-id"] === "string"
    ? req.headers["x-session-id"]
    : undefined;
  const bodySession =
    typeof req.body === "object" && req.body !== null && "sessionId" in req.body
      ? String((req.body as { sessionId?: string }).sessionId ?? "")
      : undefined;

  return normalizeSessionId(querySession ?? bodySession ?? headerSession);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Serve Stable Horde / Hugging Face generated images ─────────────────────────────────────
app.get("/api/image/:id", (req, res) => {
  try {
    const buffer = getCachedImage(req.params.id);
    if (!buffer) {
      // Image not yet generated — client can retry
      res.status(202).json({ message: "Image is still being generated, try again shortly." });
      return;
    }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (err) {
    // Generation permanently failed (e.g. invalid API key)
    res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/session", (req, res) => {
  const body = req.body as { sessionId?: string };
  const requestedSessionId = normalizeSessionId(body.sessionId);
  const session = createSession(requestedSessionId);

  res.status(201).json({
    sessionId: session.sessionId,
    maxPlayers: session.maxPlayers,
    joinUrl: `/join?sessionId=${encodeURIComponent(session.sessionId)}`,
    screenUrl: `/screen?sessionId=${encodeURIComponent(session.sessionId)}`,
  });
});

app.get("/api/session/:id", (req, res) => {
  const sessionId = normalizeSessionId(req.params.id);
  const summary = getSessionSummary(sessionId);
  res.json(summary);
});

app.get("/api/state", (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const submissions = getSubmissions(sessionId);
  const leaderboard = submissions.slice(0, 5);
  const recentResults = getRecentSubmissions(4, sessionId);
  const pendingResults = getRecentPendingSubmissions(4, sessionId);
  const summary = getSessionSummary(sessionId);

  res.json({
    sessionId: summary.sessionId,
    maxPlayers: summary.maxPlayers,
    currentPlayers: summary.currentPlayers,
    isAtCapacity: isSessionAtCapacity(summary.sessionId),
    challenge: getCurrentChallenge(summary.sessionId),
    submissions,
    leaderboard,
    latest: recentResults[0] ?? null,
    recentResults,
    pendingResults,
  });
});

app.post("/api/state", (_req, res) => {
  const sessionId = getSessionIdFromRequest(_req);
  const body = _req.body as { resetLeaderboard?: boolean | string };
  const resetLeaderboard =
    body.resetLeaderboard === true || body.resetLeaderboard === "true";
  const challenge = resetLeaderboard ? startNextBatch(sessionId) : rotateChallenge(sessionId);
  const summary = getSessionSummary(sessionId);
  res.json({ challenge, sessionId: summary.sessionId, resetLeaderboard });
});

app.get("/api/survey", (_req, res) => {
  res.json({ message: "Use POST /api/survey to submit feedback." });
});

app.get("/api/feedback", async (req, res) => {
  try {
    const querySession = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const sessionId = normalizeSessionId(querySession);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;

    const payload = await getFeedbackEntries({
      sessionId,
      limit,
    });

    res.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch feedback entries.";
    res.status(500).json({ message });
  }
});

app.post("/api/submit", async (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    const body = req.body as {
      sessionId?: string;
      playerName?: string;
      prompt?: string;
      autoSubmitted?: boolean | string;
    };

    const playerName = body.playerName?.trim();
    const prompt = body.prompt?.trim() ?? "";
    const autoSubmitted = body.autoSubmitted === true || body.autoSubmitted === "true";

    if (!playerName) {
      res.status(400).json({ message: "playerName is required." });
      return;
    }

    if (!prompt && !autoSubmitted) {
      res.status(400).json({ message: "prompt is required." });
      return;
    }

    if (prompt.length < 15 && !autoSubmitted) {
      res.status(400).json({ message: "Prompt is too short. Add more scene detail." });
      return;
    }

    const challenge = getCurrentChallenge(sessionId);

    // Pre-generate the submission ID so we can build the final image URL
    // BEFORE creating the submission — no placeholder that could break the result page.
    const submissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imageUrl = `${backendUrl}/api/image/${submissionId}`;

    // Create pending submission immediately with text-only scores
    const pending = createPendingSubmission({
      id: submissionId,
      sessionId,
      playerName,
      prompt,
      generatedImageUrl: imageUrl,
      imageSimilarity: undefined,
      forceZeroScore: autoSubmitted && !prompt,
    });

    const summary = getSessionSummary(sessionId);

    try {
      await saveSubmissionEvent({
        gameId: pending.sessionId ?? summary.sessionId,
        submissionId: pending.id,
        playerName: pending.playerName,
        challengeId: pending.challenge.id,
        challengeTitle: pending.challenge.title,
        submittedPrompt: pending.prompt,
        generatedImageUrl: pending.generatedImageUrl,
        submittedAt: pending.createdAt,
      });
    } catch (error) {
      // Keep gameplay responsive even if telemetry write fails.
      console.error("saveSubmissionEvent failed", error);
    }

    // ── Respond immediately ─────────────────────────────────────────────────
    res.status(201).json({
      pendingId: pending.id,
      sessionId: summary.sessionId,
      surveyUrl: `/survey/${pending.id}?sessionId=${encodeURIComponent(summary.sessionId)}`,
    });

    // ── Background: generate image + compare (non-blocking) ─────────────────
    // Stable Horde distributes load across many volunteer GPU workers.
    // By the time the user finishes the survey (30–60 s) the image is ready.
    if (prompt) {
      void (async () => {
        try {
          logMemory("before-generate");
          const imageBuffer = await generateImage(pending.id, prompt);
          const actualImageUrl = `${backendUrl}/api/image/${pending.id}`;

          // Compare generated image with the challenge reference image
          let imageSimilarity: number | undefined;
          try {
            imageSimilarity = await compareTargetUrlWithBuffer(
              toAbsoluteUrl(challenge.imageUrl),
              imageBuffer,
            );
          } catch (compErr) {
            console.warn("Image comparison failed — text-only score kept", compErr);
          }

          updatePendingSubmissionImageAndScore(
            pending.id,
            actualImageUrl,
            imageSimilarity ?? 0,
            sessionId,
          );
          logMemory(`after-generate score=${imageSimilarity}`);
        } catch (err) {
          console.warn("Stable Horde generation failed — text-only score kept", err);
        }
      })();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit prompt.";
    res.status(500).json({ message });
  }
});

app.post("/api/survey", async (req, res) => {
  try {
    const sessionId = getSessionIdFromRequest(req);
    const body = req.body as {
      sessionId?: string;
      submissionId?: string;
      applicationsUsed?: string[];
      worksWellAspects?: string[];
      improvementAreas?: string[];
      worksWellOther?: string;
      improvementOther?: string;
      additionalFeedback?: string;
    };

    const submissionId = body.submissionId?.trim();
    const applicationsUsed = Array.isArray(body.applicationsUsed)
      ? body.applicationsUsed.filter((item) => typeof item === "string" && item.trim())
      : [];
    const worksWellAspects = Array.isArray(body.worksWellAspects)
      ? body.worksWellAspects.filter((item) => typeof item === "string" && item.trim())
      : [];
    const improvementAreas = Array.isArray(body.improvementAreas)
      ? body.improvementAreas.filter((item) => typeof item === "string" && item.trim())
      : [];
    const worksWellOther = body.worksWellOther?.trim() ?? "";
    const improvementOther = body.improvementOther?.trim() ?? "";
    const additionalFeedback = body.additionalFeedback?.trim() ?? "";

    if (!submissionId) {
      res.status(400).json({ message: "submissionId is required." });
      return;
    }

    const pending = getPendingSubmissionById(submissionId, sessionId);
    if (!pending) {
      const finalized = getSubmissionById(submissionId, sessionId);
      if (finalized) {
        const retryFeedbackPayload: SurveyFeedback = {
          gameId: finalized.sessionId ?? sessionId ?? "main",
          submissionId: finalized.id,
          playerName: finalized.playerName,
          challengeId: finalized.challenge.id,
          challengeTitle: finalized.challenge.title,
          submittedPrompt: finalized.prompt,
          finalScore: finalized.scores.finalScore,
          promptLength: finalized.prompt.length,
          appUsesByPlayer: getPlayerSubmissionCount(finalized.playerName, sessionId),
          applicationsUsed,
          worksWellAspects,
          improvementAreas,
          worksWellOther,
          improvementOther,
          additionalFeedback,
          submittedAt: new Date().toISOString(),
        };

        try {
          await saveFeedback(retryFeedbackPayload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to store feedback.";
          res.status(500).json({ message });
          return;
        }

        res.status(200).json({
          id: finalized.id,
          resultUrl: `/result/${finalized.id}`,
          status: "already_finalized",
        });
        return;
      }

      // Submission not found — server likely restarted and lost ephemeral store.
      // Save the feedback with whatever we have and return success so the user
      // is not blocked.
      const orphanFeedbackPayload: SurveyFeedback = {
        gameId: sessionId ?? "main",
        submissionId: submissionId,
        playerName: "unknown",
        challengeId: "unknown",
        challengeTitle: "unknown",
        submittedPrompt: "",
        finalScore: 0,
        promptLength: 0,
        appUsesByPlayer: 0,
        applicationsUsed,
        worksWellAspects,
        improvementAreas,
        worksWellOther,
        improvementOther,
        additionalFeedback,
        submittedAt: new Date().toISOString(),
      };

      try {
        await saveFeedback(orphanFeedbackPayload);
      } catch (error) {
        console.warn("Unable to save orphan feedback", { submissionId, error });
      }

      res.status(200).json({
        id: submissionId,
        resultUrl: null,
        status: "submission_expired",
      });
      return;
    }

    const feedbackPayload: SurveyFeedback = {
      gameId: pending.sessionId ?? sessionId ?? "main",
      submissionId: pending.id,
      playerName: pending.playerName,
      challengeId: pending.challenge.id,
      challengeTitle: pending.challenge.title,
      submittedPrompt: pending.prompt,
      finalScore: pending.scores.finalScore,
      promptLength: pending.prompt.length,
      appUsesByPlayer: getPlayerSubmissionCount(pending.playerName, sessionId) + 1,
      applicationsUsed,
      worksWellAspects,
      improvementAreas,
      worksWellOther,
      improvementOther,
      additionalFeedback,
      submittedAt: new Date().toISOString(),
    };

    try {
      await saveFeedback(feedbackPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to store feedback.";
      res.status(500).json({ message });
      return;
    }

    const submission = finalizePendingSubmission(submissionId, sessionId);
    if (!submission) {
      res.status(500).json({ message: "Unable to finalize this submission." });
      return;
    }

    res.status(201).json({
      id: submission.id,
      resultUrl: `/result/${submission.id}`,
    });
  } catch (error) {
    console.error("Unhandled /api/survey error", {
      sessionId: getSessionIdFromRequest(req),
      body: req.body,
      error,
    });
    const message = error instanceof Error ? error.message : "Unable to submit survey feedback.";
    res.status(500).json({ message });
  }
});

app.get("/api/submission/:id", (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const id = req.params.id;

  const pending = getPendingSubmissionById(id, sessionId);
  if (pending) {
    res.json({ status: "pending", submission: pending });
    return;
  }

  const finalized = getSubmissionById(id, sessionId);
  if (finalized) {
    res.json({ status: "finalized", submission: finalized });
    return;
  }

  res.status(404).json({ message: "Submission not found." });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error.";
  res.status(500).json({ message });
});

function logMemory(label: string) {
  const mem = process.memoryUsage();
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
  console.log(
    `[MEM] ${label} | RSS: ${mb(mem.rss)} | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)} | External: ${mb(mem.external)}`
  );
}

app.listen(port, () => {
  console.log(`Prompt Wars backend running on http://localhost:${port}`);
  logMemory("startup");
  setInterval(() => logMemory("heartbeat"), 60_000);
});
