import { Jimp } from "jimp";

const COMPARE_WIDTH = 64;
const COMPARE_HEIGHT = 64;
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new Error(`Failed image fetch: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function preprocess(image: JimpImage) {
  return image.clone().resize({ w: COMPARE_WIDTH, h: COMPARE_HEIGHT }).greyscale();
}

function mseSimilarity(imageA: JimpImage, imageB: JimpImage): number {
  const a = preprocess(imageA);
  const b = preprocess(imageB);
  const pixels = COMPARE_WIDTH * COMPARE_HEIGHT;

  let squaredError = 0;
  for (let i = 0; i < a.bitmap.data.length; i += 4) {
    const lumA = a.bitmap.data[i] ?? 0;
    const lumB = b.bitmap.data[i] ?? 0;
    const diff = lumA - lumB;
    squaredError += diff * diff;
  }

  const mse = squaredError / pixels;
  const normalized = 1 - mse / (255 * 255);
  return clamp(Math.round(normalized * 100), 0, 100);
}

export async function compareImageUrls(
  targetImageUrl: string,
  generatedImageUrl: string,
): Promise<number> {
  const [targetBuffer, generatedBuffer] = await Promise.all([
    fetchImageBuffer(targetImageUrl),
    fetchImageBuffer(generatedImageUrl),
  ]);

  const [target, generated] = await Promise.all([
    Jimp.read(targetBuffer),
    Jimp.read(generatedBuffer),
  ]);

  return mseSimilarity(target, generated);
}

export async function compareTargetUrlWithBuffer(
  targetImageUrl: string,
  generatedBuffer: Buffer,
): Promise<number> {
  const targetBuffer = await fetchImageBuffer(targetImageUrl);

  const [target, generated] = await Promise.all([
    Jimp.read(targetBuffer),
    Jimp.read(generatedBuffer),
  ]);

  return mseSimilarity(target, generated);
}
