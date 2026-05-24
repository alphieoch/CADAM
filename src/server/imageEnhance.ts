import sharp from 'sharp';

/**
 * Enhances a seed image before 3D generation to maximize detail
 * captured by the TRELLIS model.
 *
 * Pipeline:
 * 1. Upscale to 1536×1536 (50% larger than 1024) using Lanczos3
 * 2. Apply unsharp mask for edge clarity
 * 3. Slight contrast boost to help depth estimation
 * 4. Output as high-quality PNG
 */
export async function enhanceSeedImage(inputBuffer: Buffer): Promise<Buffer> {
  return sharp(inputBuffer)
    .resize(1536, 1536, {
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
    })
    .sharpen({
      sigma: 1.2,
      m1: 1.0,
      m2: 2.0,
    })
    .modulate({
      brightness: 1.05,
      saturation: 1.1,
    })
    .png({
      quality: 95,
      compressionLevel: 6,
    })
    .toBuffer();
}

/**
 * Light enhancement for fast mode — just resize + mild sharpen.
 * Cheaper CPU cost than full enhancement.
 */
export async function enhanceSeedImageLight(
  inputBuffer: Buffer,
): Promise<Buffer> {
  return sharp(inputBuffer)
    .resize(1280, 1280, {
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
    })
    .sharpen({
      sigma: 0.8,
      m1: 0.5,
      m2: 1.0,
    })
    .png({ quality: 90 })
    .toBuffer();
}
