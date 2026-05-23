import { corsHeaders, isRecord } from './api';
import { fal } from '@fal-ai/client';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import {
  generateImageWithFalFlux,
  generateImageWithGeminiMultiTurn,
  generateImageWithGptImage2,
  INSTRUCTIONS_3D as instructions3D,
  type GptImageQuality,
} from './imageGen';
import { Model, MeshFileType } from '@shared/types';
import { query } from './dbClient';
import {
  uploadBlob,
  getSignedUrl,
  getContainerClient,
} from './storageClient';
import { getUserFromRequest } from './auth';
import { billing, BillingClientError } from './stripeBilling';
import { logApiError, logError } from './serverLog';
import { Buffer } from 'node:buffer';
import { env, requiredEnv, webhookBaseUrl } from './env';

const MESH_TOKEN_COST = 30;

// Initialize Sentry for error logging

// Constants
const TEXTURELESS_MAX_POLYGONS = 50000;

const DEBUG_LOGS =
  env('ENVIRONMENT') === 'local' || env('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

function optionalErrorField(error: unknown, field: 'body' | 'status') {
  return isRecord(error) ? error[field] : undefined;
}

function runBackgroundTask(task: Promise<unknown>) {
  const loggedTask = task.catch((error) => {
    console.error('Background task failed:', error);
  });
  const requestContext = Reflect.get(
    globalThis,
    Symbol.for('@vercel/request-context'),
  );
  if (isRecord(requestContext) && typeof requestContext.get === 'function') {
    const context = requestContext.get();
    if (isRecord(context) && typeof context.waitUntil === 'function') {
      context.waitUntil(loggedTask);
      return;
    }
  }
  void loggedTask;
}

// Returns the image_generation_call_id to thread into the next gpt-image-2
// call, or null when the prior image was produced by a fallback (Gemini/Flux)
// and has no call ID.
//
// Branch-aware: when the user is editing a specific mesh (via the `mesh`
// request param), we prefer that mesh's latest image — otherwise a global
// "most recent in conversation" lookup would grab a sibling-branch image the
// user isn't looking at, and gpt-image-2 would silently edit the wrong
// output. Without a specific mesh in focus, fall back to conversation-wide
// latest (linear editing flow).
//
// We do NOT filter for non-null call IDs: if the last turn fell back,
// skipping its null row and surfacing an older gpt-image-2 call ID would
// make gpt-image-2 edit an image two turns ago while the user is looking
// at the fallback output.
async function getPriorImageCallId(
  userId: string,
  conversationId: string,
  preferMeshId: string | undefined,
): Promise<string | null> {
  if (preferMeshId) {
    // CRITICAL: filter by user_id + conversation_id here. preferMeshId comes
    // from the untrusted request body, and the service-role client bypasses
    // RLS. Without this filter, a user could pass another user's mesh UUID
    // to thread the victim's OpenAI multi-turn continuity ID into their own
    // gpt-image-2 call.
    const meshResult = await query(
      'SELECT images FROM meshes WHERE id = $1 AND user_id = $2 AND conversation_id = $3',
      [preferMeshId, userId, conversationId],
    );
    const meshRow = meshResult.rows[0];
    const meshImageIds = Array.isArray(meshRow?.images)
      ? meshRow.images.filter(
          (image): image is string => typeof image === 'string',
        )
      : [];
    if (meshImageIds.length > 0) {
      const imageResult = await query(
        `SELECT image_generation_call_id FROM images
         WHERE id = ANY($1) AND user_id = $2 AND conversation_id = $3 AND status = 'success'
         ORDER BY created_at DESC LIMIT 1`,
        [meshImageIds, userId, conversationId],
      );
      return imageResult.rows[0]?.image_generation_call_id ?? null;
    }
  }

  const imageResult = await query(
    `SELECT image_generation_call_id FROM images
     WHERE conversation_id = $1 AND user_id = $2 AND status = 'success'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId, userId],
  );

  return imageResult.rows[0]?.image_generation_call_id ?? null;
}

// Unified mesh-image generation. Every mesh mode goes through this helper:
//   1. Primary: gpt-image-2 via OpenAI Responses API (canonical per OpenAI
//      docs, supports multi-turn via image_generation_call id)
//   2. Fallback 1: Gemini 3 Pro Image Preview (nano banana pro)
//   3. Fallback 2: Flux (fal-ai)
//
// Flux is also the sole provider for mesh previews (see submitPreviewJob),
// which intentionally does not go through this chain.
// Per-mode gpt-image-2 quality. fast mode defaults to `low` ($0.006/image,
// cheaper than the Flux it replaced) since fast-mode output is inherently
// draft quality. quality/ultra use `high` ($0.21/image) for final seed
// fidelity. See https://developers.openai.com/api/docs/guides/image-generation
// for pricing tiers.
const QUALITY_BY_MESH_MODEL: Record<
  'fast' | 'quality' | 'ultra',
  GptImageQuality
> = {
  fast: 'low',
  quality: 'high',
  ultra: 'high',
};

async function generateMeshImage(
  userId: string,
  conversationId: string,
  prompt: string,
  // Fresh references uploaded in *this* turn — take precedence for base64.
  freshUserImages: string[],
  // All available reference images in the conversation (includes mesh
  // previews and prior mesh images) — used when no fresh upload.
  allImages: string[],
  // The specific mesh the user is editing from (branch anchor), if any.
  // Makes the multi-turn lookup branch-aware.
  priorMeshId: string | undefined,
  sentryStage: { meshModel: 'fast' | 'quality' | 'ultra'; subStage?: string },
): Promise<{
  imageBytes: Buffer;
  imageCallId: string | null;
  contentType: 'image/jpeg' | 'image/png';
}> {
  const storageCompat = createStorageCompat();
  const hasFreshUserImages = freshUserImages.length > 0;
  // Skip the call-id lookup when the user is providing fresh reference
  // material — we want gpt-image-2 to anchor on the new upload, not a
  // prior turn's output.
  let priorImageCallId: string | null;
  // Tri-state for observability so Sentry breadcrumbs distinguish
  // "threaded a prior id", "no prior existed" (or prior was a fallback),
  // and "prior existed but we suppressed it because the user uploaded
  // fresh reference material this turn".
  let priorImageCallIdStatus:
    | 'threaded'
    | 'none_available'
    | 'suppressed_by_fresh_upload';
  if (hasFreshUserImages) {
    priorImageCallId = null;
    priorImageCallIdStatus = 'suppressed_by_fresh_upload';
  } else {
    priorImageCallId = await getPriorImageCallId(
      userId,
      conversationId,
      priorMeshId,
    );
    priorImageCallIdStatus =
      priorImageCallId !== null ? 'threaded' : 'none_available';
  }
  const gptImageReferenceImages = hasFreshUserImages
    ? freshUserImages
    : allImages;

  const sentryContext = {
    functionName: 'mesh' as const,
    statusCode: 500,
    userId,
    conversationId,
  };

  let provider: 'gpt-image-2' | 'nano-banana-pro' | 'flux';
  let result: {
    imageBytes: Buffer;
    imageCallId: string | null;
    contentType: 'image/jpeg' | 'image/png';
  };

  try {
    result = await generateImageWithGptImage2(
      storageCompat as any,
      getOpenAI(),
      userId,
      conversationId,
      prompt,
      gptImageReferenceImages,
      priorImageCallId,
      QUALITY_BY_MESH_MODEL[sentryStage.meshModel],
    );
    provider = 'gpt-image-2';
  } catch (gptImageError) {
    logError(gptImageError, {
      ...sentryContext,
      additionalContext: {
        stage: 'gpt_image_2_fallback',
        hasFreshUserImages,
        priorImageCallIdStatus,
        ...sentryStage,
      },
    });
    try {
      const imageBytes = await generateImageWithGeminiMultiTurn(
        storageCompat as any,
        getGoogleGenAI(),
        userId,
        conversationId,
        prompt,
        gptImageReferenceImages,
      );
      // Gemini Multi-Turn returns png.
      result = { imageBytes, imageCallId: null, contentType: 'image/png' };
      provider = 'nano-banana-pro';
    } catch (geminiError) {
      logError(geminiError, {
        ...sentryContext,
        additionalContext: {
          stage: 'nano_banana_pro_fallback',
          hasFreshUserImages,
          priorImageCallIdStatus,
          ...sentryStage,
        },
      });
      try {
        const imageBytes = await generateImageWithFalFlux(
          storageCompat as any,
          userId,
          conversationId,
          prompt,
          gptImageReferenceImages,
        );
        // Flux returns png per its output_format config.
        result = { imageBytes, imageCallId: null, contentType: 'image/png' };
        provider = 'flux';
      } catch (fluxError) {
        logError(fluxError, {
          ...sentryContext,
          additionalContext: {
            stage: 'flux_fallback',
            hasFreshUserImages,
            priorImageCallIdStatus,
            ...sentryStage,
          },
        });
        throw fluxError;
      }
    }
  }

  // Diagnostic log — gated on DEBUG_LOGS. In prod, ground truth comes from:
  //   - images.image_generation_call_id (null = fallback ran, non-null = gpt-image-2)
  //   - Sentry events tagged stage=gpt_image_2_fallback / nano_banana_pro_fallback
  //     / flux_fallback with full meshModel + subStage context
  // This line stays opt-in for live debugging without polluting prod logs.
  debugLog(
    `[mesh] image_gen provider=${provider} meshModel=${sentryStage.meshModel}` +
      (sentryStage.subStage ? ` subStage=${sentryStage.subStage}` : '') +
      (provider === 'gpt-image-2'
        ? ` quality=${QUALITY_BY_MESH_MODEL[sentryStage.meshModel]}`
        : '') +
      ` contentType=${result.contentType}` +
      ` callId=${result.imageCallId ?? 'none'}`,
  );

  return result;
}

// Helper function to get the most recent mesh preview from the conversation
async function getRecentMeshPreview(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    // Get the most recent mesh from this conversation
    const meshResult = await query(
      `SELECT id FROM meshes
       WHERE user_id = $1 AND conversation_id = $2 AND status = 'success'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, conversationId],
    );

    const recentMesh = meshResult.rows[0];

    if (!recentMesh) {
      return null;
    }

    // Check if a preview exists for this mesh
    const container = getContainerClient('images');
    const prefix = `${userId}/${conversationId}/preview-${recentMesh.id}`;
    const blobs: string[] = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      blobs.push(blob.name);
      if (blobs.length >= 1) break;
    }

    if (blobs.length === 0) {
      return null;
    }

    return blobs[0].split('/').pop() || null;
  } catch (error) {
    console.warn('Failed to get recent mesh preview:', error);
    return null;
  }
}

let falConfigured = false;
function ensureFalConfig() {
  if (falConfigured) return;
  const falKey = env('FAL_KEY');
  if (!falKey) {
    console.warn('FAL_KEY is not set — mesh generation will be unavailable');
    return;
  }
  fal.config({ credentials: falKey });
  falConfigured = true;
}

function getGoogleGenAI() {
  return new GoogleGenAI({ apiKey: requiredEnv('GOOGLE_API_KEY') });
}

function getOpenAI() {
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
}

export async function handleMeshRequest(req: Request) {
  try {
    debugLog('=== DENO.SERVE MESH FUNCTION ENTRY POINT ===');
    debugLog('Mesh function called', {
      method: req.method,
      url: req.url,
      timestamp: new Date().toISOString(),
    });

    if (req.method === 'OPTIONS') {
      console.log('=== HANDLING OPTIONS REQUEST ===');
      return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      console.log('=== METHOD NOT ALLOWED ===', req.method);
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authenticate user using JWT cookie
    debugLog('=== AUTHENTICATING USER ===');
    const user = await getUserFromRequest(req);
    if (!user?.id || !user.email) {
      logError(new Error('No user found in JWT cookie'), {
        functionName: 'mesh',
        statusCode: 401,
      });
      return new Response(
        JSON.stringify({ error: { message: 'Unauthorized' } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Deduct tokens for mesh operation via adam-billing
    if (!user.email) {
      return new Response(
        JSON.stringify({ error: { message: 'User email missing' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Check that required AI service keys are configured
    const hasFalKey = !!env('FAL_KEY');
    const hasOpenAIKey = !!env('OPENAI_API_KEY');
    const hasGoogleKey = !!env('GOOGLE_API_KEY');
    if (!hasFalKey && !hasOpenAIKey && !hasGoogleKey) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              'Mesh generation is not configured. FAL_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY must be set.',
            code: 'mesh_not_configured',
          },
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    ensureFalConfig();
    const appBaseUrl = webhookBaseUrl(req.url);
    const meshReferenceId = crypto.randomUUID();
    try {
      const result = await billing.consume(user.email, {
        tokens: MESH_TOKEN_COST,
        operation: 'mesh',
        referenceId: meshReferenceId,
      });
      if (!result.ok) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'insufficient_tokens',
              code: 'insufficient_tokens',
              tokensRequired: result.tokensRequired,
              tokensAvailable: result.tokensAvailable,
            },
          }),
          {
            status: 402,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
    } catch (err) {
      const status = err instanceof BillingClientError ? err.status : 502;
      logError(err, {
        functionName: 'mesh',
        statusCode: status,
        userId: user.id,
      });
      return new Response(
        JSON.stringify({ error: { message: 'billing_unavailable' } }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const requestBody = await req.json();

    debugLog('=== MESH FUNCTION CALLED ===');
    debugLog('Mesh function request body:', {
      ...requestBody,
      text: requestBody.text
        ? requestBody.text.substring(0, 100) + '...'
        : undefined,
    });

    const {
      images,
      mesh,
      text,
      conversationId,
      model,
      meshTopology,
      polygonCount,
      preferredFormat,
    }: {
      images?: string[];
      mesh?: string;
      text?: string;
      conversationId?: string;
      model?: Model;
      meshTopology?: 'quads' | 'polys';
      polygonCount?: number;
      preferredFormat?: 'glb' | 'fbx';
    } = requestBody;

    debugLog('Model parameter extracted:', model);

    if (!conversationId) {
      logError(new Error('Conversation ID is required'), {
        functionName: 'mesh',
        statusCode: 400,
        userId: user?.id,
      });
      return new Response(
        JSON.stringify({ error: { message: 'Conversation ID is required' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (
      (!images || !Array.isArray(images) || images.length === 0) &&
      !text &&
      !mesh
    ) {
      logError(new Error('Images or text not found'), {
        functionName: 'mesh',
        statusCode: 400,
        userId: user?.id,
        conversationId,
        additionalContext: {
          hasImages: !!images,
          imagesLength: images?.length,
          hasText: !!text,
          hasMesh: !!mesh,
        },
      });
      return new Response(
        JSON.stringify({ error: { message: 'Images or text not found' } }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Determine file type based on model, topology, and user preference
    let fileType: MeshFileType;
    if (
      (model === 'quality' || model === 'ultra') &&
      meshTopology === 'quads'
    ) {
      // For quad topology, allow user to choose format (default to FBX for better quad support)
      fileType = preferredFormat || 'fbx';
    } else {
      // For non-quad topology, default to GLB
      fileType = 'glb';
    }

    let meshData;
    try {
      const insertResult = await query(
        `INSERT INTO meshes (user_id, conversation_id, images, file_type, prompt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          user.id,
          conversationId,
          images ?? null,
          fileType,
          {
            ...(text && { text: text }),
            ...(images && images.length > 0 && { images: images }),
            ...(mesh && { mesh: mesh }),
            ...(model && { model: model }),
          },
        ],
      );
      meshData = insertResult.rows[0];
    } catch (meshError) {
      logError(meshError, {
        functionName: 'mesh',
        statusCode: 500,
        userId: user?.id,
        conversationId,
        additionalContext: {
          operation: 'insert_mesh_record',
          fileType,
          model,
        },
      });
      return new Response(
        JSON.stringify({
          error: {
            message:
              meshError instanceof Error
                ? meshError.message
                : String(meshError),
          },
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!meshData) {
      logError(new Error('Failed to insert mesh record'), {
        functionName: 'mesh',
        statusCode: 500,
        userId: user?.id,
        conversationId,
        additionalContext: {
          operation: 'insert_mesh_record',
          fileType,
          model,
        },
      });
      return new Response(
        JSON.stringify({ error: { message: 'Failed to create mesh record' } }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Skip Flux-based preview for quality model - use Gemini image instead (via createHunyuanPreview)
    if (model !== 'quality') {
      runBackgroundTask(
        submitPreviewJob(
          text,
          images,
          mesh,
          user.id,
          conversationId,
          meshData.id,
          appBaseUrl,
        ),
      );
    }

    console.log('=== SUBMITTING MESH JOB ===');
    debugLog(
      'Final model parameter being passed to submitMeshJob:',
      model ?? 'quality',
    );

    runBackgroundTask(
      submitMeshJob(
        text,
        images,
        mesh,
        user.id,
        conversationId,
        meshData.id,
        model ?? 'quality',
        meshTopology,
        polygonCount,
        appBaseUrl,
      ),
    );

    return new Response(JSON.stringify({ id: meshData.id, fileType }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (unexpectedError) {
    console.error('=== UNEXPECTED ERROR IN MESH FUNCTION ===');
    console.error('Unexpected error:', unexpectedError);
    console.error(
      'Error stack:',
      unexpectedError instanceof Error ? unexpectedError.stack : undefined,
    );

    return new Response(
      JSON.stringify({
        error: {
          message: 'An unexpected error occurred',
          details:
            unexpectedError instanceof Error
              ? unexpectedError.message
              : String(unexpectedError),
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
}


// Function that submits a mesh job to fal
async function submitMeshJob(
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
  model: Model,
  meshTopology: 'quads' | 'polys' | undefined,
  polygonCount: number | undefined,
  appBaseUrl: string,
) {
  ensureFalConfig();
  debugLog('=== SUBMIT MESH JOB FUNCTION CALLED ===');
  debugLog('submitMeshJob received model:', model);
  // debugLog('submitMeshJob model === ultra:', model === 'ultra');

  debugLog('Environment variables:', {
    ENVIRONMENT: env('ENVIRONMENT'),
    DATABASE_URL: env('DATABASE_URL') ? 'SET' : 'NOT SET',
    WEBHOOK_BASE_URL: appBaseUrl ? 'SET' : 'NOT SET',
    appBaseUrl,
  });

  let imageInputs: string[] = [];

  try {
    // Collect all available images from different sources
    let meshImages: string[] = [];

    // If mesh is provided, get images of that mesh
    if (mesh) {
      // Get the mesh data to check if it has images
      try {
        const meshResult = await query(
          'SELECT images FROM meshes WHERE id = $1',
          [mesh],
        );
        const meshData = meshResult.rows[0];

        if (meshData) {
          // If the mesh has images in the images column, use those
          if (
            meshData.images &&
            Array.isArray(meshData.images) &&
            meshData.images.length > 0
          ) {
            // Use the image IDs directly since generateImageWithResponses expects IDs
            meshImages = meshData.images;
          } else {
            // Otherwise, use the preview images from storage
            // Check if preview images exist in storage
            const container = getContainerClient('images');
            const prefix = `${userId}/${conversationId}/preview-${mesh}`;
            const blobs: string[] = [];
            for await (const blob of container.listBlobsFlat({ prefix })) {
              blobs.push(blob.name);
            }

            if (blobs.length > 0) {
              // Just use the preview image filenames - generateImageWithResponses will handle the fallback
              meshImages = blobs
                .map((name) => name.split('/').pop()!)
                .filter(Boolean);
            }
          }
        }
      } catch (meshDataError) {
        // If we can't fetch mesh data, just continue without mesh images
        console.warn(
          `Failed to fetch mesh data: ${meshDataError instanceof Error ? meshDataError.message : String(meshDataError)}`,
        );
      }
    }

    // Get the most recent mesh preview for visual continuity
    const recentMeshPreview = await getRecentMeshPreview(userId, conversationId);

    // Combine all available images (including recent mesh preview if available)
    const allImages = [...(images || []), ...meshImages];
    if (recentMeshPreview && !allImages.includes(recentMeshPreview)) {
      allImages.push(recentMeshPreview);
    }

    // Skip initial image generation for ultra model - it has its own flow
    if (model === 'ultra') {
      // Ultra model handles image generation differently, skip to model-specific logic
      debugLog('Skipping initial image generation for ultra model');
    } else if (text && text.trim() !== '') {
      // Generate images for standard and textureless models
      if (model === 'quality') {
        // Use Gemini 3 Pro with fallback to Flux for quality model
        const imageInsertResult = await query(
          `INSERT INTO images (user_id, conversation_id, status, prompt)
           VALUES ($1, $2, 'pending', $3)
           RETURNING *`,
          [
            userId,
            conversationId,
            {
              ...(text && { text: text }),
              ...(allImages.length > 0 && { images: allImages }),
              ...(model && { model: model }),
            },
          ],
        );
        const imageData = imageInsertResult.rows[0];

        if (!imageData) {
          throw new Error('Failed to insert image record');
        }

        await query('UPDATE meshes SET images = $1 WHERE id = $2', [
          [imageData.id],
          meshId,
        ]);

        const newPrompt =
          allImages.length > 0
            ? `${instructions3D} Edit the provided image(s) to: ${text}`
            : `${instructions3D} Generate a new image: ${text}`;

        const { imageBytes, imageCallId, contentType } =
          await generateMeshImage(
            userId,
            conversationId,
            newPrompt,
            images ?? [],
            allImages,
            mesh,
            { meshModel: 'quality' },
          );

        await uploadBlob(
          'images',
          `${userId}/${conversationId}/${imageData.id}`,
          imageBytes,
          contentType,
        );

        await query(
          `UPDATE images SET status = 'success', image_generation_call_id = $1 WHERE id = $2`,
          [imageCallId, imageData.id],
        );

        const imageUrl = await getSignedUrl(
          'images',
          `${userId}/${conversationId}/${imageData.id}`,
          60,
        );

        imageInputs = [imageUrl];
      } else {
        // Standard single-image generation for fast mode
        const imageInsertResult = await query(
          `INSERT INTO images (user_id, conversation_id, status, prompt)
           VALUES ($1, $2, 'pending', $3)
           RETURNING *`,
          [
            userId,
            conversationId,
            {
              ...(text && { text: text }),
              ...(allImages.length > 0 && { images: allImages }),
              ...(model && { model: model }),
            },
          ],
        );
        const imageData = imageInsertResult.rows[0];

        if (!imageData) {
          throw new Error('Failed to insert image record');
        }

        await query('UPDATE meshes SET images = $1 WHERE id = $2', [
          [imageData.id],
          meshId,
        ]);

        const newPrompt =
          allImages.length > 0
            ? `${instructions3D} Edit the provided image(s) to: ${text}`
            : `${instructions3D} Generate a new image: ${text}`;

        const { imageBytes, imageCallId, contentType } =
          await generateMeshImage(
            userId,
            conversationId,
            newPrompt,
            images ?? [],
            allImages,
            mesh,
            { meshModel: 'fast' },
          );

        await uploadBlob(
          'images',
          `${userId}/${conversationId}/${imageData.id}`,
          imageBytes,
          contentType,
        );

        await query(
          `UPDATE images SET status = 'success', image_generation_call_id = $1 WHERE id = $2`,
          [imageCallId, imageData.id],
        );

        const imageUrl = await getSignedUrl(
          'images',
          `${userId}/${conversationId}/${imageData.id}`,
          60,
        );

        imageInputs = [imageUrl];
      }
    } else {
      // No text provided, use the collected images directly for mesh generation
      if (allImages.length === 0) {
        throw new Error('No images or text provided for mesh generation');
      }

      const imageFiles = allImages.map(
        (image: string) => `${userId}/${conversationId}/${image}`,
      );
      const imageSignedUrls = await Promise.all(
        imageFiles.map(async (path) => {
          try {
            const url = await getSignedUrl('images', path, 60);
            return { signedUrl: url, error: null };
          } catch (err) {
            return { signedUrl: undefined, error: err };
          }
        }),
      );

      // Filter out any errors and map to just get signedURL
      imageInputs = imageSignedUrls
        .filter((image) => !image.error && image.signedUrl)
        .map((image) => image.signedUrl!);

      if (imageInputs.length === 0) {
        throw new Error('No valid images found for mesh generation');
      }
    }

    // Only validate imageInputs for non-ultra models
    // Ultra generates its own images in its specific block
    if (imageInputs.length === 0 && model !== 'ultra') {
      throw new Error('No valid images for 3D generation');
    }

    debugLog('=== CHECKING MODEL TYPE ===');
    debugLog('model value:', model);

    if (model === 'ultra') {
      debugLog('=== ENTERING ULTRA MODEL PATH (MESHY V6 PREVIEW) ===');

      // Check if this is first generation or conversational edit by looking for COMPLETED meshes (not images)
      // This properly handles branching - a branch won't have completed meshes
      const existingCompletedMeshes = await query(
        `SELECT id FROM meshes WHERE conversation_id = $1 AND user_id = $2 AND status = 'success'`,
        [conversationId, userId],
      );

      const isFirstGeneration = existingCompletedMeshes.rows.length === 0;
      const hasUploadedImages = allImages.length > 0;
      const hasText = text && text.trim() !== '';

      debugLog(
        `Ultra generation type: First=${isFirstGeneration}, HasImages=${hasUploadedImages}, HasText=${hasText}`,
      );

      // Validate we have something to work with
      if (!hasText && !hasUploadedImages && isFirstGeneration) {
        throw new Error('No text or images provided for ultra generation');
      }

      // Create image record
      const imageInsertResult = await query(
        `INSERT INTO images (user_id, conversation_id, status, prompt)
         VALUES ($1, $2, 'pending', $3)
         RETURNING *`,
        [
          userId,
          conversationId,
          {
            ...(text && { text: text }),
            ...(allImages.length > 0 && { images: allImages }),
            ...(model && { model: model }),
          },
        ],
      );
      const imageData = imageInsertResult.rows[0];

      if (!imageData) {
        throw new Error('Failed to insert image record');
      }

      await query('UPDATE meshes SET images = $1 WHERE id = $2', [
        [imageData.id],
        meshId,
      ]);

      // Use the shared INSTRUCTIONS_3D preamble (imported as instructions3D).

      // Build the prompt based on conversation stage.
      let ultraPrompt: string;
      let ultraSubStage: string;
      if (isFirstGeneration && !hasUploadedImages && hasText) {
        ultraPrompt = `${instructions3D} Generate: ${text}`;
        ultraSubStage = 'first_gen_text_only';
      } else if (isFirstGeneration && hasUploadedImages) {
        ultraPrompt = hasText
          ? `${instructions3D} Edit this image to: ${text}`
          : `${instructions3D} Enhance and optimize this image for 3D model generation`;
        ultraSubStage = 'first_gen_with_upload';
      } else {
        ultraPrompt = hasUploadedImages
          ? hasText
            ? `${instructions3D} Edit the provided image(s) to: ${text}`
            : `${instructions3D} Enhance and optimize the provided image(s) for 3D model generation`
          : hasText
            ? `${instructions3D} Edit/modify the previous generation: ${text}`
            : `${instructions3D} Enhance and optimize the previous generation`;
        ultraSubStage = 'conversational';
      }

      const { imageBytes, imageCallId, contentType } = await generateMeshImage(
        userId,
        conversationId,
        ultraPrompt,
        images ?? [],
        allImages,
        mesh,
        { meshModel: 'ultra', subStage: ultraSubStage },
      );

      // Upload the generated base image
      await uploadBlob(
        'images',
        `${userId}/${conversationId}/${imageData.id}`,
        imageBytes,
        contentType,
      );

      await query(
        `UPDATE images SET status = 'success', image_generation_call_id = $1 WHERE id = $2`,
        [imageCallId, imageData.id],
      );

      // Get signed URL for the base image to send to Meshy
      const baseImageUrl = await getSignedUrl(
        'images',
        `${userId}/${conversationId}/${imageData.id}`,
        60,
      );

      // Configure Meshy parameters
      // Topology: default to triangle (Meshy standard), but respect quad if requested
      const meshyTopology = meshTopology === 'quads' ? 'quad' : 'triangle';

      // Polycount: default 30000, clamp between 200 and 300000 (Meshy v6 API limit)
      const safePolycount = polygonCount
        ? Math.max(200, Math.min(300000, polygonCount))
        : 30000;

      debugLog('Submitting to Meshy v6 Preview', {
        topology: meshyTopology,
        polycount: safePolycount,
      });

      const meshyInput = {
        image_url: baseImageUrl,
        topology: meshyTopology as 'quad' | 'triangle',
        target_polycount: safePolycount,
        symmetry_mode: 'auto' as const,
        should_remesh: true,
        should_texture: true,
        enable_pbr: true, // Max quality feature
      };

      await fal.queue.submit('fal-ai/meshy/v6-preview/image-to-3d', {
        input: meshyInput,
        webhookUrl: `${appBaseUrl}/cadam/api/fal-webhook?id=${meshId}`,
      });

      debugLog('Successfully submitted to Meshy v6 Preview');

      // Create preview using the base image
      await createHunyuanPreview(
        baseImageUrl,
        'ultra meshy v6 preview',
        userId,
        conversationId,
        meshId,
        appBaseUrl,
      );
    } else if (model === 'quality') {
      debugLog('=== ENTERING QUALITY MODEL PATH (SAM 3D) ===');

      if (imageInputs.length === 0) {
        throw new Error('No valid image found for quality mesh generation');
      }

      const imageUrl = imageInputs[0];

      // ========================================================================
      // SAM 3D PIPELINE WITH MOONDREAM3 CAPTIONING
      // Strategy:
      // 1. Pre-fetch Moondream3 long caption and genericize it
      // 2. Try simple prompt "all the 3d models in the scene" first
      // 3. If low score, fallback to genericized caption
      // 4. If still no mask, use full-image box prompt as last resort
      // ========================================================================

      // ---- Step 1: Caption image with Moondream3 (long only to save CPU) ----
      let longCaption: string | null = null;

      try {
        debugLog('Step 1: Captioning image with Moondream3 (long only)...');

        const longResult = await fal.subscribe(
          'fal-ai/moondream3-preview/caption',
          {
            input: { length: 'long', image_url: imageUrl },
          },
        );

        const longData = longResult.data;
        if (longData && typeof longData === 'object' && 'output' in longData) {
          longCaption =
            typeof longData.output === 'string' ? longData.output : null;
        }

        debugLog('Moondream3 caption:', longCaption?.substring(0, 100) + '...');

        // Genericize the caption - replace character names with visual descriptions
        if (longCaption) {
          const genericizePrompt = `Replace ALL character names, brand names, IP names, and proper nouns with generic visual descriptions. Keep sentence structure intact.

Rules:
- Replace ANY character name (Pikachu, Sonic, Mario, Dexter, SpongeBob, etc.) with visual descriptions
- "Pikachu" -> "yellow creature with pointed ears"
- "Sonic" -> "blue spiky creature"  
- "Dexter" -> "boy with glasses" or "humanoid figure"
- "SpongeBob" -> "yellow sponge creature"
- Remove references like "from Dexter's Laboratory" or "from Pokemon"
- Keep color, pose, action, and position descriptions
- Keep ALL non-name words exactly the same

Input: ${longCaption}

Output:`;

          try {
            const genericResult = await getGoogleGenAI().models.generateContent(
              {
                model: 'gemini-2.5-flash-lite',
                contents: [
                  { role: 'user', parts: [{ text: genericizePrompt }] },
                ],
              },
            );
            const genericText =
              genericResult.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (genericText) {
              longCaption = genericText;
              debugLog(
                'Genericized caption:',
                longCaption.substring(0, 100) + '...',
              );
            }
          } catch (genError) {
            debugLog('Failed to genericize, using original:', genError);
          }
        }
      } catch (error) {
        debugLog('Error getting Moondream3 caption:', error);
      }

      // ---- Step 2: Try prompts with SAM-3/image ----
      let maskUrl: string | null = null;
      const MIN_MASK_SCORE = 0.25;

      // Helper to try a prompt with SAM-3/image
      const tryPrompt = async (name: string, prompt: string) => {
        try {
          debugLog(`Trying prompt "${name}":`, prompt);
          const result = await fal.subscribe('fal-ai/sam-3/image', {
            input: {
              image_url: imageUrl,
              prompt: prompt,
              apply_mask: false,
              include_scores: true,
            },
          });

          const data = result.data;
          if (!data || typeof data !== 'object') {
            return { name, score: 0, url: null };
          }

          const masks =
            'masks' in data && Array.isArray(data.masks) ? data.masks : [];
          const scores =
            'scores' in data && Array.isArray(data.scores) ? data.scores : [];

          const score = typeof scores[0] === 'number' ? scores[0] : 0;
          const firstMask = masks[0];
          const url =
            firstMask &&
            typeof firstMask === 'object' &&
            'url' in firstMask &&
            typeof firstMask.url === 'string'
              ? firstMask.url
              : null;

          debugLog(`Prompt "${name}" result:`, { score, hasMask: !!url });
          return { name, score, url };
        } catch (error) {
          debugLog(`Prompt "${name}" failed:`, error);
          return { name, score: 0, url: null };
        }
      };

      // Try "simple" first, fallback to long_caption
      debugLog('Step 2: Trying "simple" prompt first...');
      let result = await tryPrompt('simple', 'all the 3d models in the image');

      if (result.url && result.score >= MIN_MASK_SCORE) {
        maskUrl = result.url;
        debugLog('SUCCESS: Using "simple" mask, score:', result.score);
      } else if (longCaption) {
        debugLog(
          '"simple" failed or low score, trying long_caption fallback...',
        );
        result = await tryPrompt('long_caption', longCaption);

        if (result.url && result.score >= MIN_MASK_SCORE) {
          maskUrl = result.url;
          debugLog(
            'SUCCESS: Using "long_caption" fallback mask, score:',
            result.score,
          );
        }
      } else {
        debugLog(
          'WARNING: Simple prompt failed and no Moondream caption available for fallback',
        );
      }

      if (maskUrl) {
        debugLog('Selected mask URL:', maskUrl.substring(0, 50) + '...');
      } else {
        debugLog('No valid mask from prompts, will use box fallback');
      }

      // Build SAM-3D input
      interface Sam3dInput {
        image_url: string;
        mask_urls?: string[];
        box_prompts?: {
          x_min: number;
          y_min: number;
          x_max: number;
          y_max: number;
          object_id: number;
        }[];
      }
      const sam3dInput: Sam3dInput = { image_url: imageUrl };

      if (maskUrl) {
        sam3dInput.mask_urls = [maskUrl];
        debugLog('Using SAM-3/image mask for SAM 3D');
      } else {
        // Fallback: full-image box prompt (5% inset, assumes 1024x1024)
        // This guarantees segmentation when text prompts fail
        sam3dInput.box_prompts = [
          { x_min: 51, y_min: 51, x_max: 973, y_max: 973, object_id: 1 },
        ];
        debugLog('No mask found, using full-image box fallback');
      }

      debugLog('SAM 3D input:', JSON.stringify(sam3dInput, null, 2));

      await fal.queue.submit('fal-ai/sam-3/3d-objects', {
        input: sam3dInput,
        webhookUrl: `${appBaseUrl}/cadam/api/fal-webhook?id=${meshId}`,
      });

      debugLog('Successfully submitted to SAM 3D');

      // Create preview
      await createHunyuanPreview(
        imageUrl,
        'quality SAM 3D seed image',
        userId,
        conversationId,
        meshId,
        appBaseUrl,
      );
    } else {
      debugLog('=== ENTERING FAST MODEL PATH (TRIPO TEXTURELESS) ===');

      // Use the image generated in the earlier block
      if (imageInputs.length === 0) {
        throw new Error('No valid image found for textureless mesh generation');
      }

      // Submit to Tripo v2.5 with the generated image
      // NOTE: H3.1 (newer model) currently returns downstream_service_error on
      // textureless requests (Tripo-side 500). Reverted to v2.5 until fixed.
      const tripoInput = {
        image_url: imageInputs[0],
        texture: 'no' as const,
        orientation: 'default' as const,
        // Cap face count for textureless generations at 50k
        ...(polygonCount !== undefined
          ? { face_limit: Math.min(polygonCount, TEXTURELESS_MAX_POLYGONS) }
          : { face_limit: TEXTURELESS_MAX_POLYGONS }),
      };
      try {
        await fal.queue.submit('tripo3d/tripo/v2.5/image-to-3d', {
          input: tripoInput,
          webhookUrl: `${appBaseUrl}/cadam/api/fal-webhook?id=${meshId}`,
        });
        debugLog(
          'Successfully submitted to Tripo v2.5 textureless with conversational context',
        );
      } catch (submitError) {
        console.error('Tripo v2.5 submit failed:', {
          message:
            submitError instanceof Error
              ? submitError.message
              : String(submitError),
          status: optionalErrorField(submitError, 'status'),
          body: optionalErrorField(submitError, 'body'),
          input: tripoInput,
        });
        throw submitError;
      }

      // Create preview using the generated image
      await createHunyuanPreview(
        imageInputs[0],
        'textureless preview',
        userId,
        conversationId,
        meshId,
        appBaseUrl,
      );
    }
  } catch (error) {
    console.error('Mesh generation failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      meshId,
      model,
      hasText: !!text,
      hasImages: !!(images && images.length > 0),
      imageInputsLength: imageInputs.length,
      appBaseUrl,
    });

    logApiError(error, {
      functionName: 'mesh',
      apiName: 'FAL AI',
      statusCode: 500,
      userId,
      conversationId,
      requestData: { meshId, model, meshTopology, polygonCount },
    });

    await query("UPDATE meshes SET status = 'failure' WHERE id = $1", [
      meshId,
    ]).catch((err) => {
      console.error('Failed to update mesh failure status:', err);
    });
  }
}


// Function that submits a mesh job to fal
async function submitPreviewJob(
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
  appBaseUrl: string,
) {
  ensureFalConfig();

  let imageInputs: string[] = [];

  let previewId: string | null = null;

  try {
    const previewInsertResult = await query(
      `INSERT INTO previews (user_id, conversation_id, mesh_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, conversationId, meshId],
    );
    const previewData = previewInsertResult.rows[0];

    if (!previewData) {
      throw new Error('Failed to insert preview record');
    }

    previewId = previewData.id;

    // Collect all available images from different sources
    let meshImages: string[] = [];

    // If mesh is provided, get images of that mesh
    if (mesh) {
      // Get the mesh data to check if it has images
      try {
        const meshResult = await query(
          'SELECT images FROM meshes WHERE id = $1',
          [mesh],
        );
        const meshData = meshResult.rows[0];

        if (meshData) {
          // If the mesh has images in the images column, use those
          if (
            meshData.images &&
            Array.isArray(meshData.images) &&
            meshData.images.length > 0
          ) {
            // Use the image IDs directly since generateImageWithResponses expects IDs
            meshImages = meshData.images;
          } else {
            // Otherwise, use the preview images from storage
            // Check if preview images exist in storage
            const container = getContainerClient('images');
            const prefix = `${userId}/${conversationId}/preview-${mesh}`;
            const blobs: string[] = [];
            for await (const blob of container.listBlobsFlat({ prefix })) {
              blobs.push(blob.name);
            }

            if (blobs.length > 0) {
              // Just use the preview image filenames - generateImageWithResponses will handle the fallback
              meshImages = blobs
                .map((name) => name.split('/').pop()!)
                .filter(Boolean);
            }
          }
        }
      } catch (meshDataError) {
        // If we can't fetch mesh data, just continue without mesh images
        console.warn(
          `Failed to fetch mesh data: ${meshDataError instanceof Error ? meshDataError.message : String(meshDataError)}`,
        );
      }
    }

    // Combine all available images
    const allImages = [...(images || []), ...meshImages];

    const imageGuidance =
      'You are generating a fully textured and rendered 3D model. Output one centered 3D model or multiple centered objects, no text.  Plain white background (or an empty background which provides optimal contrast with the textures of the 3D model) , neutral lighting, and a soft shadow directly under the 3D model. Keep the entire object fully in-frame with 5–10% padding; no cropping. Make sure the description strongly impacts the form and shape of the 3D Model not just the surface texture';

    // If text exists, we generate an image from 4o then use that image to generate a mesh
    if (text && text.trim() !== '') {
      const newPrompt =
        allImages.length > 0
          ? `Edit the provided image(s) to: ${text} Style: ${imageGuidance}`
          : `Generate a new image: ${text} Style: ${imageGuidance}`;

      const imageBytes = await generateImageWithFalFlux(
        createStorageCompat() as any,
        userId,
        conversationId,
        newPrompt,
        allImages,
      );

      const imageId = crypto.randomUUID();

      await uploadBlob(
        'images',
        `${userId}/${conversationId}/${imageId}`,
        imageBytes,
        'image/png',
      );

      const imageUrl = await getSignedUrl(
        'images',
        `${userId}/${conversationId}/${imageId}`,
        60,
      );

      imageInputs = [imageUrl];
    } else {
      // No text provided, use the collected images directly for mesh generation
      if (allImages.length === 0) {
        throw new Error('No images or text provided for mesh generation');
      }

      const imageFiles = allImages.map(
        (image: string) => `${userId}/${conversationId}/${image}`,
      );
      const imageSignedUrls = await Promise.all(
        imageFiles.map(async (path) => {
          try {
            const url = await getSignedUrl('images', path, 60);
            return { signedUrl: url, error: null };
          } catch (err) {
            return { signedUrl: undefined, error: err };
          }
        }),
      );

      // Filter out any errors and map to just get signedURL
      imageInputs = imageSignedUrls
        .filter((image) => !image.error && image.signedUrl)
        .map((image) => image.signedUrl!);

      if (imageInputs.length === 0) {
        throw new Error('No valid images found for mesh generation');
      }
    }

    if (imageInputs.length === 0) {
      throw new Error('No valid images for 3D generation');
    }

    await fal.queue.submit('fal-ai/hunyuan3d/v2/mini/turbo', {
      input: {
        input_image_url: imageInputs[0],
      },
      webhookUrl: `${appBaseUrl}/cadam/api/fal-webhook?id=${previewId}&mode=preview`,
    });
  } catch (error) {
    logApiError(error, {
      functionName: 'mesh',
      apiName: 'FAL AI Preview',
      statusCode: 500,
      userId,
      conversationId,
      requestData: { previewId, meshId },
    });
    console.error(error);
    if (previewId) {
      query(
        "UPDATE previews SET status = 'failure' WHERE id = $1",
        [previewId],
      ).catch((err) => {
        console.error('Failed to update preview failure status:', err);
      });
    }
  }
  // Don't need to send update to channel because it's not a mesh we care about
}

// Helper function to create GLB preview using Hunyuan3D Mini Turbo
async function createHunyuanPreview(
  imageUrl: string,
  description: string,
  userId: string,
  conversationId: string,
  meshId: string,
  appBaseUrl: string,
): Promise<void> {
  ensureFalConfig();
  try {
    const previewInsertResult = await query(
      `INSERT INTO previews (user_id, conversation_id, mesh_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, conversationId, meshId],
    );
    const previewData = previewInsertResult.rows[0];

    if (!previewData) {
      debugLog('Failed to create preview record: no row returned');
      return;
    }

    if (previewData) {
      // Hunyuan3D Mini Turbo for fast preview generation
      await fal.queue.submit('fal-ai/hunyuan3d/v2/mini/turbo', {
        input: {
          input_image_url: imageUrl,
        },
        webhookUrl: `${appBaseUrl}/cadam/api/fal-webhook?id=${previewData.id}&mode=preview`,
      });
      debugLog(`Successfully submitted ${description} to Hunyuan3D Mini Turbo`);
    }
  } catch (error) {
    debugLog(
      `Error creating Hunyuan preview: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Compatibility wrapper that exposes a Supabase-storage-like API backed by
// Azure Blob Storage. This lets imageGen.ts helpers (which still expect a
// Supabase client) work in Azure-native mode without crashing.
function createStorageCompat() {
  return {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            try {
              const container = getContainerClient(bucket);
              const blockBlob = container.getBlockBlobClient(path);
              const [buffer, properties] = await Promise.all([
                blockBlob.downloadToBuffer(),
                blockBlob.getProperties(),
              ]);
              return {
                data: {
                  type: properties.contentType || 'image/png',
                  async arrayBuffer() {
                    return buffer.buffer.slice(
                      buffer.byteOffset,
                      buffer.byteOffset + buffer.byteLength,
                    );
                  },
                },
                error: null,
              };
            } catch (err) {
              return { data: null, error: err };
            }
          },
          async exists(path: string) {
            try {
              const container = getContainerClient(bucket);
              const blockBlob = container.getBlockBlobClient(path);
              const exists = await blockBlob.exists();
              return { data: exists, error: null };
            } catch (err) {
              return { data: false, error: err };
            }
          },
          async createSignedUrl(path: string, expirySeconds: number) {
            try {
              const url = await getSignedUrl(
                bucket,
                path,
                Math.ceil(expirySeconds / 60),
              );
              return { data: { signedUrl: url }, error: null };
            } catch (err) {
              return { data: null, error: err };
            }
          },
          async createSignedUrls(paths: string[], expirySeconds: number) {
            const results = await Promise.all(
              paths.map(async (path) => {
                try {
                  const url = await getSignedUrl(
                    bucket,
                    path,
                    Math.ceil(expirySeconds / 60),
                  );
                  return { signedUrl: url, error: null };
                } catch (err) {
                  return { signedUrl: undefined, error: err };
                }
              }),
            );
            return { data: results, error: null };
          },
        };
      },
    },
  };
}
