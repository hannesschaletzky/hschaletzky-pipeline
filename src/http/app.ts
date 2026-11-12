import { sql } from 'drizzle-orm';
import express, { type ErrorRequestHandler, type Express } from 'express';

import { MCP_PATH, type McpAuth } from '../auth/index.js';

import type { Database } from '../db/client.js';
import { log } from '../log.js';
import { mcpMethodNotAllowed, mcpPostHandler } from '../mcp/http.js';

export interface AppOptions {
  db: Database;
  /**
   * OAuth for /mcp. Required to mount the endpoint at all, so it can never be exposed
   * without authentication by accident.
   */
  auth?: McpAuth;
}

export function createApp({ db, auth }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy: use X-Forwarded-For from exactly one proxy hop (rate limiting, logs).
  app.set('trust proxy', 1);

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

  if (auth) {
    app.use(auth.routes);
    // Seed imports can carry many posting texts at once.
    app.post(MCP_PATH, auth.bearer, express.json({ limit: '5mb' }), mcpPostHandler(db));
    app.get(MCP_PATH, auth.bearer, mcpMethodNotAllowed);
    app.delete(MCP_PATH, auth.bearer, mcpMethodNotAllowed);
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    log.error('unhandled request error', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}
