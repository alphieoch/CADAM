import { Buffer } from 'node:buffer';
import { env } from './env';

const DEBUG_LOGS =
  env('ENVIRONMENT') === 'local' || env('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const KREA_API_BASE = 'https://api.krea.ai';

function getKreaKey(): string {
  const key = env('KREA_API_KEY');
  if (!key) throw new Error('KREA_API_KEY is not set');
  return key;
}

interface KreaJob {
  job_id: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  result?: {
    urls?: string[];
  };
}

async function kreaRequest(path: string, body: unknown): Promise<KreaJob> {
  const res = await fetch(`${KREA_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getKreaKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown');
    throw new Error(`Krea ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<KreaJob>;
}

async function pollKreaJob(jobId: string, maxAttempts = 60): Promise<KreaJob> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${KREA_API_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${getKreaKey()}` },
    });
    if (!res.ok) continue;
    const job = (await res.json()) as KreaJob;
    debugLog(`Krea job ${jobId}: ${job.status}`);
    if (job.status === 'completed' || job.status === 'failed') return job;
  }
  throw new Error(`Krea job ${jobId} timed out`);
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ============================================================================
// Image Generation Models
// ============================================================================

export type KreaImageModel =
  | 'imagen-4-ultra'
  | 'imagen-4'
  | 'imagen-4-fast'
  | 'nano-banana-pro'
  | 'nano-banana-2'
  | 'gpt-image-2'
  | 'flux-1.1-pro-ultra'
  | 'flux-1.1-pro';

const MODEL_ENDPOINTS: Record<KreaImageModel, string> = {
  'imagen-4-ultra': '/generate/image/google/imagen-4-ultra',
  'imagen-4': '/generate/image/google/imagen-4',
  'imagen-4-fast': '/generate/image/google/imagen-4-fast',
  'nano-banana-pro': '/generate/image/google/nano-banana-pro',
  'nano-banana-2': '/generate/image/google/nano-banana-2',
  'gpt-image-2': '/generate/image/openai/gpt-image-2',
  'flux-1.1-pro-ultra': '/generate/image/bfl/flux-1.1-pro-ultra',
  'flux-1.1-pro': '/generate/image/bfl/flux-1.1-pro',
};

/**
 * Generate an image using Krea's API.
 */
export async function generateImageWithKrea(
  prompt: string,
  model: KreaImageModel = 'imagen-4-ultra',
  options: {
    width?: number;
    height?: number;
    seed?: number;
    imageUrl?: string; // For image-to-image
  } = {},
): Promise<Buffer> {
  const endpoint = MODEL_ENDPOINTS[model];
  if (!endpoint) throw new Error(`Unknown Krea model: ${model}`);

  const body: Record<string, unknown> = {
    prompt,
    width: options.width ?? 1024,
    height: options.height ?? 1024,
  };
  if (options.seed !== undefined) body.seed = options.seed;
  if (options.imageUrl) body.imageUrl = options.imageUrl;

  debugLog(`Krea image gen: ${model}`, prompt.substring(0, 50));
  const job = await kreaRequest(endpoint, body);
  const completed = await pollKreaJob(job.job_id);

  if (completed.status !== 'completed') {
    throw new Error(`Krea image generation failed: ${completed.status}`);
  }

  const url = completed.result?.urls?.[0];
  if (!url) throw new Error('No image URL in Krea result');

  return downloadImage(url);
}

// ============================================================================
// Image Enhancement (Topaz)
// ============================================================================

export type KreaEnhanceModel =
  | 'Standard V2'
  | 'Low Resolution V2'
  | 'CGI'
  | 'High Fidelity V2'
  | 'Text Refine';

/**
 * Enhance/upscale an image using Krea Topaz.
 */
export async function enhanceImageWithKrea(
  imageUrl: string,
  options: {
    width: number;
    height: number;
    model?: KreaEnhanceModel;
  },
): Promise<Buffer> {
  const body = {
    image_url: imageUrl,
    width: options.width,
    height: options.height,
    model: options.model ?? 'Standard V2',
  };

  debugLog('Krea enhance:', body);
  const job = await kreaRequest('/generate/enhance/topaz/standard-enhance', body);
  const completed = await pollKreaJob(job.job_id);

  if (completed.status !== 'completed') {
    throw new Error(`Krea enhancement failed: ${completed.status}`);
  }

  const url = completed.result?.urls?.[0];
  if (!url) throw new Error('No image URL in Krea enhance result');

  return downloadImage(url);
}
