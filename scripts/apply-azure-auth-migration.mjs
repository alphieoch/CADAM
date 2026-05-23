import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL || 
  'postgresql://cadamadmin:uo5xO1W7rJD49ZyUcitKBy19@cadam-db-1fab1eb5.postgres.database.azure.com:5432/cadam?sslmode=require';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function applyMigration() {
  const sql = readFileSync(
    join(__dirname, '../supabase/migrations/20260522000000_azure_auth.sql'),
    'utf-8'
  );
  
  console.log('Applying Azure auth migration...');
  
  try {
    await pool.query(sql);
    console.log('✅ Migration applied successfully');
    
    // Verify tables exist
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'user_passwords', 'user_sessions')
    `);
    console.log('Tables created:', result.rows.map(r => r.table_name).join(', '));
    
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

applyMigration();
