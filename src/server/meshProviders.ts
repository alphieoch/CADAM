import { Buffer } from 'node:buffer';
import { fal } from '@fal-ai/client';
import { query } from './dbClient';
import { uploadBlob } from './storageClient';
import { env } from './env';
import {
  uploadKreaAsset,
  executeKrea3D,
  pollKreaJob,
  downloadGlb,
} from './krea3d';

const DEBUG_LOGS =
  env('ENVIRONMENT') === 'local' || env('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

// ============================================================================
// Provider Types
// ============================================================================

export interface MeshProvider {
  id: string;
  name: string;
  description: string;
  tokenCost: number; // Billing tokens per generation
  timeEstimate: string;
  isAvailable: () => boolean;
  generate: (
    imageUrl: string,
    meshId: string,
    userId: string,
    conversationId: string,
  ) => Promise<void>;
}

// ============================================================================
// Krea TRELLIS Provider (basic — the one node app we have)
// ============================================================================

const kreaTrellisProvider: MeshProvider = {
  id: 'krea-trellis',
  name: 'TRELLIS',
  description: 'High quality 3D model generator via Krea',
  tokenCost: 10,
  timeEstimate: '~30 sec',
  isAvailable: () => !!env('KREA_API_KEY'),
  generate: async (imageUrl, meshId, userId, conversationId) => {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download seed image: ${imageResponse.status}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const kreaImageUrl = await uploadKreaAsset(imageBuffer, 'image/png');
    const jobId = await executeKrea3D(kreaImageUrl);
    const { trellisUrl } = await pollKreaJob(jobId);
    const glbBuffer = await downloadGlb(trellisUrl);
    await saveMeshAndPreview(glbBuffer, meshId, userId, conversationId);
  },
};

// ============================================================================
// FAL.ai Providers
// ============================================================================

function ensureFalConfig() {
  const falKey = env('FAL_KEY');
  if (!falKey) throw new Error('FAL_KEY is not set');
  fal.config({ credentials: falKey });
}

async function submitFal3D(
  endpoint: string,
  input: Record<string, unknown>,
  meshId: string,
  userId: string,
  conversationId: string,
) {
  ensureFalConfig();
  debugLog(`Submitting to FAL ${endpoint}:`, input);

  const result = await fal.subscribe(endpoint, {
    input,
    pollInterval: 5000,
    logs: true,
  });

  debugLog(`FAL ${endpoint} result:`, result.data);

  // FAL 3D outputs vary by model — extract the GLB/OBJ URL
  const data = result.data as Record<string, unknown>;
  let modelUrl: string | null = null;

  if (data && typeof data === 'object') {
    // Try common output paths
    const d = data as Record<string, any>;
    const outputs = [
      d.model_mesh?.url,
      d.model_mesh,
      d.mesh?.url,
      d.mesh,
      d.glb?.url,
      d.glb,
      d.output?.url,
      d.output,
      d.video?.url,
      d.video,
    ];
    for (const out of outputs) {
      if (typeof out === 'string' && out.startsWith('http')) {
        modelUrl = out;
        break;
      }
    }
  }

  if (!modelUrl) {
    throw new Error(
      `No model URL in FAL response for ${endpoint}: ${JSON.stringify(data)}`,
    );
  }

  // Download the model file
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to download model from FAL: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  await saveMeshAndPreview(buffer, meshId, userId, conversationId);
}

const falHunyuan3dTurboProvider: MeshProvider = {
  id: 'fal-hunyuan3d-turbo',
  name: 'Hunyuan3D-2.1',
  description: 'Fast Hunyuan3D with turbo speed',
  tokenCost: 25,
  timeEstimate: '~20 sec',
  isAvailable: () => !!env('FAL_KEY'),
  generate: async (imageUrl, meshId, userId, conversationId) => {
    await submitFal3D(
      'fal-ai/hunyuan3d/v2/mini/turbo',
      { input_image_url: imageUrl },
      meshId,
      userId,
      conversationId,
    );
  },
};

const falHunyuan3dV31Provider: MeshProvider = {
  id: 'fal-hunyuan3d-v31',
  name: 'Hunyuan3D 3.1 Pro',
  description: 'High-fidelity 3D with optional PBR materials and multi-view',
  tokenCost: 60,
  timeEstimate: '~2-3 min',
  isAvailable: () => !!env('FAL_KEY'),
  generate: async (imageUrl, meshId, userId, conversationId) => {
    await submitFal3D(
      'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d',
      {
        input_image_url: imageUrl,
        enable_pbr: true,
      },
      meshId,
      userId,
      conversationId,
    );
  },
};

const falTripoProvider: MeshProvider = {
  id: 'fal-tripo',
  name: 'Tripo',
  description: 'High quality 3D model generator',
  tokenCost: 15,
  timeEstimate: '~40 sec',
  isAvailable: () => !!env('FAL_KEY'),
  generate: async (imageUrl, meshId, userId, conversationId) => {
    await submitFal3D(
      'fal-ai/tripo/v2_5',
      { image_url: imageUrl },
      meshId,
      userId,
      conversationId,
    );
  },
};

// ============================================================================
// Replicate TRELLIS-2 Provider
// ============================================================================

let replicateClient: unknown = null;

function getReplicateClient() {
  if (replicateClient) return replicateClient;
  const token = env('REPLICATE_API_TOKEN');
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set');
  // Dynamic import to avoid hard dependency
  const Replicate = require('replicate');
  replicateClient = new Replicate.default({ auth: token });
  return replicateClient;
}

const replicateTrellis2Provider: MeshProvider = {
  id: 'replicate-trellis-2',
  name: 'TRELLIS 2',
  description: 'Native 3D generative model for high-quality asset creation',
  tokenCost: 50,
  timeEstimate: '~2-3 min',
  isAvailable: () => !!env('REPLICATE_API_TOKEN'),
  generate: async (imageUrl, meshId, userId, conversationId) => {
    const client = getReplicateClient() as any;
    const output = (await client.run('tencent/trellis-2', {
      input: { image: imageUrl },
    })) as unknown;

    let glbBuffer: Buffer;
    if (output instanceof Buffer) {
      glbBuffer = output;
    } else if (Array.isArray(output) && output[0] instanceof Buffer) {
      glbBuffer = output[0];
    } else if (
      Array.isArray(output) &&
      output.length > 0 &&
      typeof output[0] === 'string'
    ) {
      const url = output[0] as string;
      const response = await fetch(url);
      glbBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      throw new Error(`Unexpected Replicate output: ${typeof output}`);
    }

    await saveMeshAndPreview(glbBuffer, meshId, userId, conversationId);
  },
};

// ============================================================================
// Provider Registry
// ============================================================================

export const MESH_PROVIDERS: MeshProvider[] = [
  falHunyuan3dV31Provider,   // ~200 Krea credits equivalent → 60 tokens
  replicateTrellis2Provider, // ~150 Krea credits equivalent → 50 tokens
  falHunyuan3dTurboProvider, // ~25 Krea credits equivalent → 25 tokens
  falTripoProvider,          // ~8 Krea credits equivalent → 15 tokens
  kreaTrellisProvider,       // ~10 Krea credits equivalent → 10 tokens
];

export function getAvailableProviders(): MeshProvider[] {
  return MESH_PROVIDERS.filter((p) => p.isAvailable());
}

export function getProviderById(id: string): MeshProvider | undefined {
  return MESH_PROVIDERS.find((p) => p.id === id);
}

// ============================================================================
// Shared: Save mesh + preview to Azure Blob
// ============================================================================

export async function saveMeshAndPreview(
  buffer: Buffer,
  meshId: string,
  userId: string,
  conversationId: string,
) {
  // Create preview record
  const previewResult = await query(
    `INSERT INTO previews (user_id, conversation_id, mesh_id, status)
     VALUES ($1, $2, $3, 'success')
     RETURNING id`,
    [userId, conversationId, meshId],
  );
  const previewId = previewResult.rows[0]?.id;

  // Upload to meshes container
  await uploadBlob(
    'meshes',
    `${userId}/${conversationId}/${meshId}.glb`,
    buffer,
    'model/gltf-binary',
  );

  // Upload to previews container
  if (previewId) {
    await uploadBlob(
      'previews',
      `${userId}/${conversationId}/${previewId}.glb`,
      buffer,
      'model/gltf-binary',
    );
  }

  // Update mesh status
  await query(
    "UPDATE meshes SET status = 'success', file_type = 'glb' WHERE id = $1",
    [meshId],
  );
}
