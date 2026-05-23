import { SignJWT, jwtVerify } from 'jose';
import { query } from './dbClient';

// JWT configuration
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'cadam-dev-secret-change-in-production-min-32-chars-long!!'
);
const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRES_IN = '7d';
const COOKIE_NAME = 'cadam-session';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  provider: string;
}

// Create a JWT token for a user
export async function createToken(user: AuthUser): Promise<string> {
  return new SignJWT({
    sub: user.id,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    provider: user.provider,
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRES_IN)
    .setJti(crypto.randomUUID())
    .sign(JWT_SECRET);
}

// Verify a JWT token and return the payload
export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      clockTolerance: 60,
    });
    return payload;
  } catch {
    return null;
  }
}

// Parse JWT payload into AuthUser
export function payloadToUser(payload: Record<string, unknown>): AuthUser {
  return {
    id: String(payload.sub),
    email: String(payload.email),
    full_name: payload.full_name ? String(payload.full_name) : null,
    avatar_url: payload.avatar_url ? String(payload.avatar_url) : null,
    provider: String(payload.provider || 'email'),
  };
}

// Extract token from cookie header
export function getTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Build Set-Cookie header for setting the session cookie
export function buildCookieHeader(token: string, clear = false): string {
  const maxAge = clear ? 0 : 60 * 60 * 24 * 7; // 7 days
  const value = clear ? '' : encodeURIComponent(token);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

// Get current user from request
export async function getUserFromRequest(request: Request): Promise<AuthUser | null> {
  const cookie = request.headers.get('cookie');
  const token = getTokenFromCookie(cookie);
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return payloadToUser(payload as Record<string, unknown>);
}

// Require user or throw Unauthorized error
export async function requireUser(request: Request): Promise<AuthUser> {
  const user = await getUserFromRequest(request);
  if (!user) {
    throw new Error('Unauthorized');
  }
  return user;
}

// Fetch full user record from database
export async function getUserFromDb(userId: string): Promise<AuthUser | null> {
  const result = await query<{ id: string; email: string; full_name: string | null; avatar_url: string | null; provider: string }>(
    'SELECT id, email, full_name, avatar_url, provider FROM public.users WHERE id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
}

// OAuth state helpers
export function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array));
}

// Microsoft OAuth URLs
export function getMicrosoftAuthUrl(state: string, redirectUri: string): string {
  // Use /common to support both personal Microsoft accounts and work/school accounts
  const clientId = process.env.MICROSOFT_CLIENT_ID || '';
  
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
  });

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

// Exchange Microsoft auth code for tokens
export async function exchangeMicrosoftCode(code: string, redirectUri: string) {
  const clientId = process.env.MICROSOFT_CLIENT_ID || '';
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';

  const response = await fetch(`https://login.microsoftonline.com/common/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Microsoft token exchange failed: ${error}`);
  }

  return response.json() as Promise<{
    access_token: string;
    id_token: string;
    token_type: string;
    expires_in: number;
  }>;
}

// Fetch Microsoft user profile
export async function fetchMicrosoftUser(accessToken: string) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch Microsoft user profile');
  }

  return response.json() as Promise<{
    id: string;
    displayName: string;
    givenName?: string;
    surname?: string;
    mail?: string;
    userPrincipalName: string;
  }>;
}

// Google OAuth URLs
export function getGoogleAuthUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange Google auth code for tokens
export async function exchangeGoogleCode(code: string, redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }

  return response.json() as Promise<{
    access_token: string;
    id_token: string;
    token_type: string;
    expires_in: number;
  }>;
}

// Fetch Google user profile
export async function fetchGoogleUser(accessToken: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch Google user profile');
  }

  return response.json() as Promise<{
    id: string;
    email: string;
    name: string;
    picture?: string;
  }>;
}
