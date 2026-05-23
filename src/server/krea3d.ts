import { Buffer } from 'node:buffer';
import { env } from './env';

const DEBUG_LOGS =
  env('ENVIRONMENT') === 'local' || env('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const KREA_API_BASE = 'https://api.krea.ai';
const KREA_3D_NODE_APP_ID = '54b41bac-b5ae-4b3a-91ae-ff97003f0dc6';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 30; // 2.5 minutes max

function getKreaKey(): string {
  const key = env('KREA_API_KEY');
  if (!key) {
    throw new Error('KREA_API_KEY is not set');
  }
  return key;
}

interface KreaAsset {
  id: string;
  image_url: string;
  uploaded_at: string;
  width: number;
  height: number;
  size_bytes: number;
  mime_type: string;
}

interface KreaJob {
  job_id: string;
  status:
    | 'backlogged'
    | 'queued'
    | 'scheduled'
    | 'processing'
    | 'sampling'
    | 'intermediate-complete'
    | 'completed'
    | 'failed'
    | 'cancelled';
  created_at: string;
  completed_at: string | null;
  result?: {
    urls?: Record<string, string>;
    workflow_id?: string;
  };
}

/**
 * Upload an image buffer to Krea assets and return the public image URL.
 */
export async function uploadKreaAsset(
  imageBuffer: Buffer,
  mimeType: string = 'image/png',
): Promise<string> {
  const kreaKey = getKreaKey();
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('file', blob, 'seed-image.png');

  const response = await fetch(`${KREA_API_BASE}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kreaKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Krea asset upload failed: ${response.status} ${errorText}`,
    );
  }

  const asset = (await response.json()) as KreaAsset;
  debugLog('Krea asset uploaded:', asset.id, asset.image_url);
  return asset.image_url;
}

/**
 * Execute the Krea 3D generator node app with an image URL.
 * Returns the job ID for polling.
 */
export async function executeKrea3D(imageUrl: string): Promise<string> {
  const kreaKey = getKreaKey();

  const response = await fetch(
    `${KREA_API_BASE}/node-apps/${KREA_3D_NODE_APP_ID}/execute`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kreaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: imageUrl }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Krea 3D execution failed: ${response.status} ${errorText}`,
    );
  }

  const jobs = (await response.json()) as Array<{
    job_id: string;
    status: string;
  }>;
  const jobId = jobs[0]?.job_id;
  if (!jobId) {
    throw new Error('Krea 3D execution returned no job ID');
  }

  debugLog('Krea 3D job started:', jobId);
  return jobId;
}

/**
 * Poll a Krea job until it completes or fails.
 * Returns the result URLs.
 */
export async function pollKreaJob(
  jobId: string,
  maxAttempts: number = MAX_POLL_ATTEMPTS,
): Promise<{ trellisUrl: string }> {
  const kreaKey = getKreaKey();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(`${KREA_API_BASE}/jobs/${jobId}`, {
      headers: {
        Authorization: `Bearer ${kreaKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Krea job poll failed: ${response.status} ${errorText}`,
      );
    }

    const job = (await response.json()) as KreaJob;
    debugLog(`Krea job poll [${attempt}/${maxAttempts}]:`, job.status);

    if (job.status === 'completed') {
      const trellisUrl = job.result?.urls?.trellis;
      if (!trellisUrl) {
        throw new Error('Krea job completed but no trellis URL in result');
      }
      debugLog('Krea 3D job completed:', trellisUrl);
      return { trellisUrl };
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Krea 3D job ${job.status}: ${jobId}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Krea 3D job timed out after ${maxAttempts} polls`);
}

/**
 * Download a GLB file from a URL.
 */
export async function downloadGlb(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download GLB: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Full pipeline: upload image to Krea → execute 3D generation → poll → download GLB.
 * Returns the GLB buffer.
 */
export async function generateMeshWithKrea(
  imageBuffer: Buffer,
  mimeType: string = 'image/png',
): Promise<Buffer> {
  const imageUrl = await uploadKreaAsset(imageBuffer, mimeType);
  const jobId = await executeKrea3D(imageUrl);
  const { trellisUrl } = await pollKreaJob(jobId);
  const glbBuffer = await downloadGlb(trellisUrl);
  debugLog('Krea 3D GLB downloaded:', glbBuffer.length, 'bytes');
  return glbBuffer;
}
