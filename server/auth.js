import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Simple in-process cache: token → { userId, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export async function verifyToken(token) {
  if (!token || !supabaseUrl || !supabaseKey) return null;

  const hit = cache.get(token);
  if (hit && hit.expiresAt > Date.now()) return hit.userId;

  try {
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return null;
    cache.set(token, { userId: user.id, expiresAt: Date.now() + CACHE_TTL_MS });
    return user.id;
  } catch { return null; }
}

export function authMiddleware() {
  return async (c, next) => {
    const auth = c.req.header('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await verifyToken(auth.slice(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    c.set('userId', userId);
    return next();
  };
}
