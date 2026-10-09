import { Hono } from 'hono';
import { sql } from '../db.js';
import { authMiddleware } from '../auth.js';

const data = new Hono();
data.use('/*', authMiddleware());

// GET /api/data/:key  — fetch one value
data.get('/:key', async (c) => {
  const userId = c.get('userId');
  const key    = c.req.param('key');
  try {
    const rows = await sql`
      SELECT value FROM nook_data WHERE user_id = ${userId} AND key = ${key}
    `;
    return c.json({ value: rows.length ? rows[0].value : null });
  } catch (e) {
    console.error('[data] GET error', e?.message);
    return c.json({ error: 'db_error' }, 500);
  }
});

// PUT /api/data/:key  — upsert one value  { value: <any JSON> }
data.put('/:key', async (c) => {
  const userId = c.get('userId');
  const key    = c.req.param('key');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  try {
    await sql`
      INSERT INTO nook_data (user_id, key, value, updated_at)
      VALUES (${userId}, ${key}, ${JSON.stringify(body.value)}, NOW())
      ON CONFLICT (user_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return c.json({ ok: true });
  } catch (e) {
    console.error('[data] PUT error', e?.message);
    return c.json({ error: 'db_error' }, 500);
  }
});

// DELETE /api/data/:key
data.delete('/:key', async (c) => {
  const userId = c.get('userId');
  const key    = c.req.param('key');
  try {
    await sql`DELETE FROM nook_data WHERE user_id = ${userId} AND key = ${key}`;
    return c.json({ ok: true });
  } catch (e) {
    console.error('[data] DELETE error', e?.message);
    return c.json({ error: 'db_error' }, 500);
  }
});

// GET /api/data  — all keys for user (used by export/import)
data.get('/', async (c) => {
  const userId = c.get('userId');
  try {
    const rows = await sql`
      SELECT key, value FROM nook_data WHERE user_id = ${userId}
    `;
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return c.json({ data: out });
  } catch (e) {
    console.error('[data] GET ALL error', e?.message);
    return c.json({ error: 'db_error' }, 500);
  }
});

export default data;
