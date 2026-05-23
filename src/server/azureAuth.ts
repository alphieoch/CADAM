import jwt from 'jsonwebtoken';
import jwkToPem from 'jwk-to-pem';
import { env } from './env';

interface AzureTokenPayload {
  oid: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

let signingKeys: Map<string, string> | undefined;

async function fetchSigningKeys(): Promise<Map<string, string>> {
  const tenantId = env('AZURE_TENANT_ID') || 'common';
  const jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  const res = await fetch(jwksUri);
  const jwks = (await res.json()) as { keys: unknown[] };
  const keys = new Map<string, string>();
  for (const key of jwks.keys) {
    const k = key as { kid: string; [k: string]: unknown };
    keys.set(k.kid, jwkToPem(k as any));
  }
  return keys;
}

async function getSigningKey(kid: string): Promise<string> {
  if (!signingKeys) {
    signingKeys = await fetchSigningKeys();
  }
  const key = signingKeys.get(kid);
  if (!key) {
    signingKeys = await fetchSigningKeys();
    const refreshed = signingKeys.get(kid);
    if (!refreshed) throw new Error('Unable to find signing key for token');
    return refreshed;
  }
  return key;
}

export async function verifyAzureToken(
  token: string,
): Promise<AzureTokenPayload> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('Invalid token format');
  }
  const pem = await getSigningKey(decoded.header.kid);
  const payload = jwt.verify(token, pem, {
    audience: env('AZURE_CLIENT_ID'),
    issuer: `https://login.microsoftonline.com/${env('AZURE_TENANT_ID')}/v2.0`,
    clockTolerance: 60,
  }) as AzureTokenPayload;
  return payload;
}

export async function requireAzureUser(request: Request) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = auth.slice(7);
  try {
    return await verifyAzureToken(token);
  } catch {
    throw new Error('Unauthorized');
  }
}
