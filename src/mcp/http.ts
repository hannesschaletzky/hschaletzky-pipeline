import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';

import type { Database } from '../db/client.js';
import { createMcpServer } from './server.js';

/**
 * Stateless Streamable HTTP: a fresh server and transport per request, no session state.
 * Enough for tool calls, and nothing to clean up or share between instances.
 */
export function mcpPostHandler(db: Database): RequestHandler {
  return async (req, res) => {
    const server = createMcpServer({ db });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

/** GET (server-initiated stream) and DELETE (end session) are not supported without sessions. */
export const mcpMethodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
};
