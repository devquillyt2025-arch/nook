import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { initDb } from './db.js';
import dataRoutes from './routes/data.js';

const app = new Hono();
const PORT = process.env.PORT || 3001;

// Allow requests from the Vite dev server and any deployed origin
app.use('/*', cors({
  origin: (origin) => origin || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.route('/api/data', dataRoutes);

app.get('/api/health', (c) => c.json({ ok: true }));

initDb()
  .then(() => {
    serve({ fetch: app.fetch, port: Number(PORT) }, () =>
      console.log(`Nook API server running on http://localhost:${PORT}`)
    );
  })
  .catch(err => {
    console.error('Failed to init DB:', err.message);
    process.exit(1);
  });
