import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import type { AuthConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { githubIdentity, type IdentityProvider } from './github.js';
import { PipelineOAuthProvider } from './provider.js';

export interface McpAuth {
  /** OAuth endpoints: metadata, registration, authorize, token, revoke, login callback. */
  routes: RequestHandler;
  /** Requires a valid access token bound to the MCP endpoint. */
  bearer: RequestHandler;
}

export const MCP_PATH = '/mcp';
export const LOGIN_CALLBACK_PATH = '/oauth/github/callback';

export function createMcpAuth({
  db,
  config,
  identity = githubIdentity({
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
  }),
}: {
  db: Database;
  config: AuthConfig;
  /** Injectable for tests. */
  identity?: IdentityProvider;
}): McpAuth {
  const resource = new URL(MCP_PATH, config.publicBaseUrl);
  const provider = new PipelineOAuthProvider({
    db,
    identity,
    allowedUserId: config.allowedGithubUserId,
    allowedRedirectUris: config.allowedRedirectUris,
    loginCallbackUrl: new URL(LOGIN_CALLBACK_PATH, config.publicBaseUrl).toString(),
    resource,
  });

  const routes = express.Router();
  // Metadata, /register, /authorize, /token, /revoke — each rate-limited by the SDK.
  routes.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicBaseUrl,
      resourceServerUrl: resource,
      resourceName: 'hschaletzky-pipeline',
    }),
  );
  routes.get(
    LOGIN_CALLBACK_PATH,
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    provider.loginCallback(),
  );

  return {
    routes,
    bearer: requireBearerAuth({
      verifier: provider,
      expectedResource: resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    }),
  };
}
