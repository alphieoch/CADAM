import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env, requiredEnv } from './env';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = env('DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Required for Azure PostgreSQL.',
      );
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const client = await getPool().connect();
  try {
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
