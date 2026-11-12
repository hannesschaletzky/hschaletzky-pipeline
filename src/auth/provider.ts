import { createHash, randomBytes } from 'node:crypto';

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { RequestHandler, Response } from 'express';

import type { Database } from '../db/client.js';
import { oauthClients, oauthTokens } from '../db/schema.js';
import { log } from '../log.js';
import type { IdentityProvider } from './github.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 100;

const newSecret = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

interface PendingLogin {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

/** Short-lived entries (minutes) kept in memory; bounded so they cannot grow without limit. */
class ExpiringMap<V extends { expiresAt: number }> {
  readonly #entries = new Map<string, V>();

  set(key: string, value: V): void {
    this.#prune();
    if (this.#entries.size >= MAX_PENDING) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, value);
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    return value && value.expiresAt > Date.now() ? value : undefined;
  }

  take(key: string): V | undefined {
    const value = this.get(key);
    this.#entries.delete(key);
    return value;
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, value] of this.#entries) if (value.expiresAt <= now) this.#entries.delete(key);
  }
}

export interface ProviderOptions {
  db: Database;
  identity: IdentityProvider;
  allowedUserId: number;
  allowedRedirectUris: readonly string[];
  /** Our own GitHub callback URL, e.g. https://pipeline.example.com/oauth/github/callback */
  loginCallbackUrl: string;
  /** Tokens are bound to this resource (the MCP endpoint URL). */
  resource: URL;
}

/**
 * Single-user OAuth authorization server for MCP clients (claude.ai).
 *
 * Flow: client → /authorize → GitHub login → /oauth/github/callback (checks the GitHub user id)
 * → redirect back to the client with a one-time code → /token (PKCE checked by the SDK).
 */
export class PipelineOAuthProvider implements OAuthServerProvider {
  readonly #options: ProviderOptions;
  readonly #pendingLogins = new ExpiringMap<PendingLogin>();
  readonly #codes = new ExpiringMap<IssuedCode>();

  constructor(options: ProviderOptions) {
    this.#options = options;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const { db, allowedRedirectUris } = this.#options;
    return {
      async getClient(clientId) {
        const [row] = await db
          .select({ info: oauthClients.info })
          .from(oauthClients)
          .where(eq(oauthClients.clientId, clientId));
        return row?.info as OAuthClientInformationFull | undefined;
      },
      async registerClient(client) {
        const disallowed = client.redirect_uris.filter((uri) => !allowedRedirectUris.includes(uri));
        if (disallowed.length > 0) {
          throw new InvalidClientMetadataError('redirect_uri not allowed for this server');
        }
        const full = client as OAuthClientInformationFull;
        await db.insert(oauthClients).values({ clientId: full.client_id, info: full });
        log.info('oauth client registered');
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const loginState = newSecret();
    this.#pendingLogins.set(loginState, {
      clientId: client.client_id,
      params: { ...params, resource: params.resource ?? this.#options.resource },
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    res.redirect(this.#options.identity.authorizeUrl(loginState, this.#options.loginCallbackUrl));
    return Promise.resolve();
  }

  /** GET /oauth/github/callback — the identity check happens here. */
  loginCallback(): RequestHandler {
    return async (req, res) => {
      const { code, state } = req.query;
      const pending = typeof state === 'string' ? this.#pendingLogins.take(state) : undefined;
      if (!pending || typeof code !== 'string') {
        res.status(400).type('text').send('Login expired or invalid. Please start again.');
        return;
      }

      const redirect = new URL(pending.params.redirectUri);
      if (pending.params.state !== undefined)
        redirect.searchParams.set('state', pending.params.state);

      let userId: number;
      try {
        userId = await this.#options.identity.userIdForCode(code, this.#options.loginCallbackUrl);
      } catch (error) {
        log.warn('login failed: identity provider error', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        redirect.searchParams.set('error', 'server_error');
        res.redirect(redirect.toString());
        return;
      }

      if (userId !== this.#options.allowedUserId) {
        log.warn('login denied: user not allowed');
        redirect.searchParams.set('error', 'access_denied');
        res.redirect(redirect.toString());
        return;
      }

      const authorizationCode = newSecret();
      this.#codes.set(authorizationCode, {
        clientId: pending.clientId,
        params: pending.params,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      log.info('login succeeded');
      redirect.searchParams.set('code', authorizationCode);
      res.redirect(redirect.toString());
    };
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const issued = this.#codes.get(authorizationCode);
    if (issued?.clientId !== client.client_id) {
      return Promise.reject(new InvalidGrantError('Invalid authorization code'));
    }
    return Promise.resolve(issued.params.codeChallenge);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // The SDK has already verified the PKCE code_verifier against the stored challenge.
    const issued = this.#codes.take(authorizationCode);
    if (issued?.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== issued.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match');
    }
    return this.#issueTokens(client.client_id, issued.params.scopes ?? [], issued.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    // Rotation: a refresh token is deleted when used, so a stolen one works at most once.
    const [row] = await this.#options.db
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hash(refreshToken)),
          eq(oauthTokens.kind, 'refresh'),
          eq(oauthTokens.clientId, client.client_id),
          gt(oauthTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!row) throw new InvalidGrantError('Invalid refresh token');
    return this.#issueTokens(
      client.client_id,
      row.scopes,
      row.resource === null ? undefined : new URL(row.resource),
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [row] = await this.#options.db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hash(token)),
          eq(oauthTokens.kind, 'access'),
          gt(oauthTokens.expiresAt, new Date()),
        ),
      );
    if (!row) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.clientId,
      scopes: row.scopes,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      ...(row.resource !== null && { resource: new URL(row.resource) }),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.#options.db
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hash(request.token)),
          eq(oauthTokens.clientId, client.client_id),
        ),
      );
  }

  async #issueTokens(clientId: string, scopes: string[], resource?: URL): Promise<OAuthTokens> {
    const now = Date.now();
    const accessToken = newSecret();
    const refreshToken = newSecret();
    const common = { clientId, scopes, resource: resource?.toString() ?? null };

    await this.#options.db.transaction(async (tx) => {
      await tx.delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date(now)));
      await tx.insert(oauthTokens).values([
        {
          ...common,
          tokenHash: hash(accessToken),
          kind: 'access',
          expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
        },
        {
          ...common,
          tokenHash: hash(refreshToken),
          kind: 'refresh',
          expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
        },
      ]);
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      ...(scopes.length > 0 && { scope: scopes.join(' ') }),
    };
  }
}
