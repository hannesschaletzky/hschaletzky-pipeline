import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';

import type { Database } from '../db/client.js';
import { log } from '../log.js';
import { createMcpServer } from './server.js';

/** Seed imports can carry many posting texts at once. */
export const MAX_MCP_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Serves MCP over Streamable HTTP for both protocol eras from one endpoint:
 * 2026-07-28 clients (per-request metadata, `server/discover`) and 2025-era clients
 * (`initialize` handshake, served statelessly). Every request gets a fresh server instance,
 * so there is no session state to keep, clean up or share between instances.
 * GET and DELETE (2025 session operations) are answered with 405 by the SDK.
 */
export function mcpHandler(db: Database): RequestHandler {
  const handler = createMcpHandler(() => createMcpServer({ db }), {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    // Reporting only; never log the error message, it may echo request content.
    onerror: (error) => {
      log.warn('mcp request rejected', { error: error.name });
    },
  });
  const node = toNodeHandler(handler, {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    onerror: (error) => {
      log.error('mcp handler failed', { error: error.name });
    },
  });
  return (req, res, next) => {
    node(req, res, req.body).catch(next);
  };
}
