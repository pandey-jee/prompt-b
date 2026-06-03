import { Challenge, PromptPersona, ScoreBreakdown } from "./types";

export const CHALLENGES: Challenge[] = [
  {
    id: "image-1-golf-gti-coastal",
    title: "Image 1 - Golf GTI Coastal",
    category: "easy",
    imageUrl: "/image/img%201.jpg",
  },
  {
    id: "image-2-beetle-alpine",
    title: "Image 2 - Beetle Alpine Drive",
    category: "medium",
    imageUrl: "/image/image%202.jpg",
  },
  {
    id: "image-4-id4-harbor",
    title: "Image 4 - ID.4 Harbor",
    category: "medium",
    imageUrl: "/image/image%204.jpg",
  },
  {
    id: "image-5-gti-night-track",
    title: "Image 5 - GTI Night Track",
    category: "hard",
    imageUrl: "/image/image%205.jpg",
  },
];

const CHALLENGE_REFERENCE_PROMPTS: Record<string, string> = {
  "image-1-golf-gti-coastal":
    "Cinematic photorealistic red Volkswagen Golf GTI hatchback parked on wet coastal asphalt at golden hour, front three-quarter angle facing slightly left, dramatic coastal mountains and ocean background, glossy pavement reflections, premium automotive advertisement style, realistic materials and lighting.",
  "image-2-beetle-alpine":
    "Cinematic photorealistic white Volkswagen Beetle in dynamic motion on a winding alpine mountain road, slightly elevated front three-quarter tracking perspective, background motion blur with sharp car subject, rocky cliffs, overcast daylight, premium road-trip automotive commercial composition.",
  "image-4-id4-harbor":
    "Highly realistic metallic electric blue Volkswagen ID.4 crossover SUV on a modern European waterfront promenade, front three-quarter angle facing slightly left, contemporary harbor with boats and cranes, soft overcast daylight, clean press-photography style, balanced urban composition and realistic reflections.",
  "image-5-gti-night-track":
    "Cinematic ultra-realistic modified metallic gray Volkswagen GTI concept race car on a wet racetrack at stormy night, dramatic low-angle front three-quarter perspective facing slightly right, aggressive aero body kit, glowing red LED arrow lights in background, strong volumetric lighting, glossy reflective asphalt, high-end futuristic automotive advertisement look.",
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function scoreTextAlignment(prompt: string, challengeId: string): number {
  const reference = CHALLENGE_REFERENCE_PROMPTS[challengeId] ?? "";
  const promptTokens = new Set(tokenize(prompt));
  const referenceTokens = tokenize(reference);

  if (referenceTokens.length === 0) {
    return 60;
  }

  const matched = referenceTokens.filter((token) => promptTokens.has(token)).length;
  const ratio = matched / referenceTokens.length;
  // If they match just a third of the reference words in their 60 seconds, give them max score
  const adjustedRatio = Math.min(ratio * 3, 1.0);
  return clamp(Math.round(70 + adjustedRatio * 30), 50, 100);
}

function getOrientationRule(prompt: string): string {
  const text = prompt.toLowerCase();
  const hasRight = /\bright\s*(facing|side|profile)?\b/.test(text) || /\bface\s*right\b/.test(text);
  const hasLeft = /\bleft\s*(facing|side|profile)?\b/.test(text) || /\bface\s*left\b/.test(text);

  if (hasRight && !hasLeft) {
    return "Primary subject must face right. Do not mirror to left-facing orientation.";
  }

  if (hasLeft && !hasRight) {
    return "Primary subject must face left. Do not mirror to right-facing orientation.";
  }

  return "Keep subject orientation exactly as requested in the user prompt.";
}

function getRequestedOrientation(prompt: string): "left" | "right" | null {
  const text = prompt.toLowerCase();
  const hasRight =
    /\bright\s*(facing|side|profile)?\b/.test(text) ||
    /\bface\s*right\b/.test(text) ||
    /\bfacing\s*toward\s*the\s*right\b/.test(text);
  const hasLeft =
    /\bleft\s*(facing|side|profile)?\b/.test(text) ||
    /\bface\s*left\b/.test(text) ||
    /\bfacing\s*toward\s*the\s*left\b/.test(text);

  if (hasRight && !hasLeft) {
    return "right";
  }

  if (hasLeft && !hasRight) {
    return "left";
  }

  return null;
}

function applyOrientationOverride(referencePrompt: string, prompt: string): string {
  const requested = getRequestedOrientation(prompt);
  if (!requested) {
    return referencePrompt;
  }

  const toRight = requested === "right";
  const toReplace = toRight
    ? [
        /facing\s+slightly\s+toward\s+the\s+left/gi,
        /facing\s+left/gi,
        /face\s+left/gi,
        /left-facing/gi,
      ]
    : [
        /facing\s+slightly\s+toward\s+the\s+right/gi,
        /facing\s+right/gi,
        /face\s+right/gi,
        /right-facing/gi,
      ];

  const replacement = toRight
    ? "facing slightly toward the right"
    : "facing slightly toward the left";

  let updated = referencePrompt;
  for (const pattern of toReplace) {
    updated = updated.replace(pattern, replacement);
  }

  return `${updated} Orientation override: subject must face ${requested}, never mirrored to the opposite direction.`;
}

export function seededNumber(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function createGeneratedImageUrl(prompt: string, challengeId: string): string {
  const seed = seededNumber(`${challengeId}:${prompt}`);
  const userPrompt = prompt.replace(/\s+/g, " ").trim();
  const optimizedPrompt = [
    userPrompt,
    "Photorealistic, physically based rendering, high detail textures.",
    "Accurate perspective, coherent composition, natural lighting, realistic shadows and reflections.",
    "No text overlays, no watermark.",
    "Sharp focus, 8k quality, professional color grading.",
  ].join(" ");

  return `https://image.pollinations.ai/prompt/${encodeURIComponent(
    optimizedPrompt,
  )}?model=flux&width=1024&height=1024&seed=${seed}&safe=true`;
}

export function createFallbackImageUrl(prompt: string, challengeId: string): string {
  const seed = `${challengeId}-${prompt.toLowerCase().trim().replace(/\s+/g, "-")}`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/1280/720`;
}

export function scorePrompt(
  prompt: string,
  challenge: Challenge,
  options?: {
    imageSimilarity?: number;
  },
): ScoreBreakdown {
  const text = prompt.trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const tokenCount = words.length;

  const cinematicTerms = [
    "cinematic",
    "lighting",
    "volumetric",
    "composition",
    "depth of field",
    "reflection",
    "realistic",
    "ultra detailed",
    "camera",
  ];

  const technicalTerms = [
    "enterprise",
    "dashboard",
    "holographic",
    "systems",
    "control",
    "workspace",
    "operations",
    "architecture",
    "infrastructure",
  ];

  const cinematicHits = cinematicTerms.filter((t) => text.includes(t)).length;
  const technicalHits = technicalTerms.filter((t) => text.includes(t)).length;
  
  // Heavily penalize 1-3 word prompts, but max out around 18 words (realistic for 60 seconds)
  const richness = tokenCount < 4 
    ? 0 
    : clamp(Math.round((tokenCount / 18) * 100), 20, 100);
  const textSimilarity = scoreTextAlignment(prompt, challenge.id);
  const orientationRule = getOrientationRule(prompt);
  const orientationBonus =
    orientationRule.includes("face right") || orientationRule.includes("face left") ? 8 : 0;

  const heuristicSimilarity = clamp(textSimilarity + orientationBonus, 50, 100);
  const similarity = clamp(
    Math.round(
      options?.imageSimilarity !== undefined
        // Decrease image similarity weight because pixel MSE is overly harsh on AI generations
        ? options.imageSimilarity * 0.2 + heuristicSimilarity * 0.8
        : heuristicSimilarity,
    ),
    0,
    100,
  );

  const promptQuality = clamp(Math.round(70 + richness * 0.3 + technicalHits * 5), 50, 100);
  const styleAlignment = clamp(
    Math.round(75 + cinematicHits * 8 + (challenge.category === "hard" ? 5 : 0)),
    50,
    100,
  );
  const detailCoverage = clamp(Math.round(70 + Math.min(tokenCount / 15, 1.0) * 30), 50, 100);

  const finalScore = clamp(
    Math.round(
      similarity * 0.5 +
        promptQuality * 0.2 +
        styleAlignment * 0.2 +
        detailCoverage * 0.1,
    ),
    0,
    100,
  );

  return {
    similarity,
    promptQuality,
    styleAlignment,
    detailCoverage,
    finalScore,
  };
}

export function getPromptPersona(prompt: string, finalScore: number): PromptPersona {
  const text = prompt.toLowerCase();

  const styleTag = text.includes("cinematic") || text.includes("lighting")
    ? "Cinematic Thinker"
    : text.includes("system") || text.includes("enterprise")
      ? "Structured Thinker"
      : text.includes("minimal")
        ? "Minimalist Thinker"
        : "Experimental Thinker";

  if (finalScore >= 93) {
    return {
      tier: "Neural Commander",
      styleTag,
      characterName: "Astra Prime",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=AstraPrime",
      dnaInsight:
        "Your prompt DNA combines precision and visual storytelling, producing highly aligned outputs.",
    };
  }

  if (finalScore >= 85) {
    return {
      tier: "Systems Director",
      styleTag,
      characterName: "Vector Marshal",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=VectorMarshal",
      dnaInsight:
        "Your prompt DNA is strategic and balanced, with strong control of environment and style.",
    };
  }

  if (finalScore >= 75) {
    return {
      tier: "Prompt Strategist",
      styleTag,
      characterName: "Pulse Architect",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=PulseArchitect",
      dnaInsight:
        "Your prompt DNA shows good structure and detail layering with room to sharpen specificity.",
    };
  }

  if (finalScore >= 60) {
    return {
      tier: "Visual Operator",
      styleTag,
      characterName: "Nova Operator",
      characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=NovaOperator",
      dnaInsight:
        "Your prompt DNA is directionally strong; adding camera and material detail will boost alignment.",
    };
  }

  return {
    tier: "Signal Starter",
    styleTag,
    characterName: "Echo Unit",
    characterUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=EchoUnit",
    dnaInsight:
      "Your prompt DNA has clear intent; expand atmosphere, composition, and technical cues for stronger results.",
  };
}
