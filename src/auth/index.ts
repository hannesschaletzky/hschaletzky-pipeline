import express, { type RequestHandler } from 'express';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

import type { AuthConfig } from '../config.js';
import { log } from '../log.js';

/**
 * This service is an OAuth *resource server* only. Tokens are issued by a separate
 * authorization server (hschaletzky-auth, see docs/adr/0005-external-authorization-server.md);
 * here they are only verified, locally, against the issuer's published signing keys.
 */
export interface McpAuth {
  /** Protected resource metadata (RFC 9728): tells clients where to get a token. */
  routes: RequestHandler;
  /** Requires a valid access token bound to the MCP endpoint. */
  bearer: RequestHandler;
}

export const MCP_PATH = '/mcp';
const METADATA_PATH = '/.well-known/oauth-protected-resource';

export function createMcpAuth({ config }: { config: AuthConfig }): McpAuth {
  const resource = new URL(MCP_PATH, config.publicBaseUrl).href;
  const metadataUrl = new URL(`${METADATA_PATH}${MCP_PATH}`, config.publicBaseUrl).href;
  // Keys are cached and refetched when a token names an unknown key id (key rotation).
  const jwks = createRemoteJWKSet(config.jwksUrl);

  const routes = express.Router();
  const metadata: RequestHandler = (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({
      resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'hschaletzky-pipeline',
    });
  };
  // RFC 9728 path-inserted form, plus the root form some clients try first.
  routes.get(`${METADATA_PATH}${MCP_PATH}`, metadata);
  routes.get(METADATA_PATH, metadata);

  const challenge = (error?: string) =>
    [`Bearer resource_metadata="${metadataUrl}"`, error && `error="${error}"`]
      .filter(Boolean)
      .join(', ');

  const bearer: RequestHandler = async (req, res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      res.status(401).set('WWW-Authenticate', challenge()).json({ error: 'unauthorized' });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: resource,
        typ: 'at+jwt',
        requiredClaims: ['sub', 'exp'],
      });
      // Read by the MCP SDK and passed to tool handlers as ctx.http.authInfo.
      (req as { auth?: unknown }).auth = {
        token,
        clientId: typeof payload.azp === 'string' ? payload.azp : '',
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
        expiresAt: payload.exp,
        extra: { sub: payload.sub },
      };
      next();
    } catch (error) {
      if (!(error instanceof errors.JOSEError)) {
        next(error);
        return;
      }
      // The reason (expired, wrong audience, bad signature) helps debugging; the token never.
      log.warn('access token rejected', { reason: error.code });
      res
        .status(401)
        .set('WWW-Authenticate', challenge('invalid_token'))
        .json({ error: 'invalid_token' });
    }
  };

  return { routes, bearer };
}
