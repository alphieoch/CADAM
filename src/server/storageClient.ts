import { BlobServiceClient } from '@azure/storage-blob';
import { env, requiredEnv } from './env';

let blobServiceClient: BlobServiceClient | undefined;

export function getBlobServiceClient(): BlobServiceClient {
  if (!blobServiceClient) {
    const connectionString = requiredEnv('AZURE_STORAGE_CONNECTION_STRING');
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  }
  return blobServiceClient;
}

export function getContainerClient(containerName: string) {
  return getBlobServiceClient().getContainerClient(containerName);
}

export async function uploadBlob(
  containerName: string,
  blobName: string,
  data: Buffer | Uint8Array | string,
  contentType?: string,
): Promise<string> {
  const container = getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.upload(data, data.length, {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
  });
  return blockBlob.url;
}

export async function downloadBlob(
  containerName: string,
  blobName: string,
): Promise<Buffer> {
  const container = getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobName);
  const response = await blockBlob.downloadToBuffer();
  return response;
}

export async function deleteBlob(
  containerName: string,
  blobName: string,
): Promise<void> {
  const container = getContainerClient(containerName);
  await container.getBlockBlobClient(blobName).deleteIfExists();
}

export async function getSignedUrl(
  containerName: string,
  blobName: string,
  expiryMinutes = 60,
): Promise<string> {
  const container = getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobName);
  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + expiryMinutes);
  const sasUrl = await blockBlob.generateSasUrl({
    permissions: 'r',
    expiresOn,
    protocol: 'https',
  });
  return sasUrl;
}
