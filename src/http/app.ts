import { sql } from 'drizzle-orm';
import express, { type ErrorRequestHandler, type Express } from 'express';

import { MCP_PATH, type McpAuth } from '../auth/index.js';

import type { Database } from '../db/client.js';
import { log } from '../log.js';
import { MAX_MCP_BODY_BYTES, mcpHandler } from '../mcp/http.js';
import { readBackupStatus } from '../services/backup-status.js';

export interface AppOptions {
  db: Database;
  /**
   * OAuth for /mcp. Required to mount the endpoint at all, so it can never be exposed
   * without authentication by accident.
   */
  auth?: McpAuth;
  /** Status file of the server's backup job; when set, /health reports the backup age. */
  backupStatusFile?: string | null;
}

export function createApp({ db, auth, backupStatusFile }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy: use X-Forwarded-For from exactly one proxy hop (rate limiting, logs).
  app.set('trust proxy', 1);

  // Liveness/readiness for Docker and Caddy. Returns no application data, so it stays
  // unauthenticated. A stale backup does not make the app unhealthy (Docker would restart it
  // for nothing); monitoring alerts on backup.ageHours instead.
  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({
        status: 'ok',
        ...(backupStatusFile && { backup: await readBackupStatus(backupStatusFile) }),
      });
    } catch {
      log.error('health check failed: database unreachable');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  if (auth) {
    app.use(auth.routes);
    app.all(MCP_PATH, auth.bearer, express.json({ limit: MAX_MCP_BODY_BYTES }), mcpHandler(db));
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
