import { Buffer } from 'node:buffer';
import Replicate from 'replicate';
import { env } from './env';
import { query } from './dbClient';
import { uploadBlob } from './storageClient';

const DEBUG_LOGS =
  env('ENVIRONMENT') === 'local' || env('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

let replicateClient: Replicate | null = null;

function getReplicateClient(): Replicate {
  if (replicateClient) return replicateClient;
  const token = env('REPLICATE_API_TOKEN');
  if (!token) {
    throw new Error('REPLICATE_API_TOKEN is not set');
  }
  replicateClient = new Replicate({ auth: token });
  return replicateClient;
}

export function hasReplicateToken(): boolean {
  return !!env('REPLICATE_API_TOKEN');
}

/**
 * Generate high-quality 3D mesh using Replicate TRELLIS-2.
 * TRELLIS-2 is Microsoft's state-of-the-art image-to-3D model with:
 * - PBR materials (albedo, normal, metallic, roughness)
 * - High geometric fidelity and detail preservation
 * - GLB output convertible to OBJ, FBX, STL, PLY
 *
 * Model: tencent/trellis-2
 * Cost: ~$0.03-0.05 per generation
 * Time: 1-3 minutes
 */
export async function generate3DWithReplicate(
  imageUrl: string,
  meshId: string,
  userId: string,
  conversationId: string,
): Promise<void> {
  debugLog('Starting Replicate TRELLIS-2 generation for mesh:', meshId);

  const client = getReplicateClient();

  // TRELLIS-2 accepts an image URL and produces a GLB file
  const output = (await client.run('tencent/trellis-2', {
    input: {
      image: imageUrl,
      // Optional: generate additional outputs
      // mesh: true,      // Include OBJ mesh
      // gaussian: true,  // Include Gaussian splatting PLY
    },
  })) as unknown;

  debugLog('Replicate TRELLIS-2 raw output:', output);

  // Replicate returns either a FileOutput (Buffer) or an array with the GLB
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
    // Sometimes Replicate returns a URL string
    const url = output[0] as string;
    debugLog('Replicate returned URL, downloading:', url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download GLB from Replicate: ${response.status}`);
    }
    glbBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error(
      `Unexpected Replicate output format: ${typeof output}`,
    );
  }

  debugLog('Replicate GLB downloaded:', glbBuffer.length, 'bytes');

  // Create preview record
  const previewInsertResult = await query(
    `INSERT INTO previews (user_id, conversation_id, mesh_id, status)
     VALUES ($1, $2, $3, 'success')
     RETURNING id`,
    [userId, conversationId, meshId],
  );
  const previewId = previewInsertResult.rows[0]?.id;

  // Upload GLB to Azure Blob (meshes container)
  const meshStoragePath = `${userId}/${conversationId}/${meshId}.glb`;
  await uploadBlob(
    'meshes',
    meshStoragePath,
    glbBuffer,
    'model/gltf-binary',
  );

  if (previewId) {
    const previewStoragePath = `${userId}/${conversationId}/${previewId}.glb`;
    await uploadBlob(
      'previews',
      previewStoragePath,
      glbBuffer,
      'model/gltf-binary',
    );
  }

  // Update mesh status to success and set file_type to glb
  await query(
    "UPDATE meshes SET status = 'success', file_type = 'glb' WHERE id = $1",
    [meshId],
  );

  debugLog('Replicate TRELLIS-2 generation complete for mesh:', meshId);
}
