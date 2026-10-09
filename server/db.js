import { neon } from '@neondatabase/serverless';

const url = process.env.NEON_DATABASE_URL;
if (!url) throw new Error('NEON_DATABASE_URL is required');

export const sql = neon(url);

// Run once on server start to ensure the table exists.
export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS nook_data (
      user_id    TEXT        NOT NULL,
      key        TEXT        NOT NULL,
      value      JSONB       NOT NULL DEFAULT 'null',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nook_data_user ON nook_data (user_id)
  `;
}
