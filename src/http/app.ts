import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';

import type { Database } from '../db/client.js';
import { log } from '../log.js';

export function createApp({ db }: { db: Database }): Express {
  const app = express();
  app.disable('x-powered-by');

  // Liveness/readiness for Docker and Caddy. Returns no data, so it stays unauthenticated.
  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok' });
    } catch {
      log.error('health check failed: database unreachable');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return app;
}
