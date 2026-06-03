import { Jimp } from "jimp";

const API_KEY = process.env.HF_API_KEY ?? "";
const MODEL = "stabilityai/stable-diffusion-xl-base-1.0";

// In-memory cache for generated images.
// Key: submissionId, Value: Image Buffer OR Error
const imageCache = new Map<string, Buffer | Error>();

export function getCachedImage(id: string): Buffer | undefined {
  const result = imageCache.get(id);
  if (result instanceof Error) {
    throw result;
  }
  return result;
}

// Concurrency controller to allow up to 5 simultaneous requests (Bursting)
const MAX_CONCURRENT = 5;
let activeCount = 0;
const queue: (() => Promise<void>)[] = [];

async function processQueue() {
  if (activeCount >= MAX_CONCURRENT || queue.length === 0) return;
  
  activeCount++;
  const task = queue.shift();
  
  if (task) {
    try {
      await task();
    } finally {
      activeCount--;
      processQueue(); // Process next in queue
    }
  } else {
    activeCount--;
  }
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 20): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429 || res.status === 503) {
      // If Rate Limited (429) or Model is Loading (503), wait 2.5 seconds and try again
      await new Promise(r => setTimeout(r, 2500));
      continue;
    }
    return res;
  }
  return fetch(url, options);
}

export async function generateImage(id: string, prompt: string): Promise<Buffer> {
  if (!API_KEY) {
    throw new Error("HF_API_KEY is missing in environment variables.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    queue.push(async () => {
      try {
        // Using router.huggingface.co/hf-inference to bypass regional ISP DNS blocks
        const res = await fetchWithRetry(`https://router.huggingface.co/hf-inference/models/${MODEL}`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${API_KEY}`
          },
          body: JSON.stringify({ inputs: prompt })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Hugging Face API error ${res.status}: ${errText}`);
        }

        // Hugging Face Inference API returns raw image bytes
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Cache the buffer in memory
        imageCache.set(id, buffer);
        
        // Prevent cache from growing infinitely
        if (imageCache.size > 200) {
          const firstKey = imageCache.keys().next().value;
          if (firstKey) imageCache.delete(firstKey);
        }

        resolve(buffer);
      } catch (err) {
        // Cache the error so the frontend stops polling infinitely
        imageCache.set(id, err instanceof Error ? err : new Error(String(err)));
        reject(err);
      }
    });
    
    // Trigger queue processing
    processQueue();
  });
}
