import { requireUser as jwtRequireUser, type AuthUser } from './auth';

export { jwtRequireUser as requireUser };
export type { AuthUser };

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders,
  });
}

export function preflight() {
  return new Response('ok', { headers: corsHeaders });
}

export function methodNotAllowed() {
  return json({ error: 'method_not_allowed' }, 405);
}

export function isUnauthorizedError(error: unknown) {
  return error instanceof Error && error.message === 'Unauthorized';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
