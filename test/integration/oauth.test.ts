import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IdentityProvider } from '../../src/auth/github.js';
import { createMcpAuth } from '../../src/auth/index.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const OWNER_ID = 4242;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let testDb: TestDatabase;
let database: DatabaseHandle;
let server: Server;
let baseUrl: string;
/** The GitHub user id the fake identity provider reports for the next login. */
let loggedInUserId = OWNER_ID;

const fakeGithub: IdentityProvider = {
  authorizeUrl: (state, callbackUrl) =>
    `https://github.example/login?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
  userIdForCode: (code) =>
    code === 'github-code'
      ? Promise.resolve(loggedInUserId)
      : Promise.reject(new Error('bad code')),
};

beforeAll(async () => {
  testDb = await startTestDatabase();
  database = createDatabase(testDb.appUrl);

  // The public base URL must contain the port, which is only known after listening.
  const late: { app?: Express } = {};
  server = createServer((req, res) => {
    late.app?.(req, res);
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const auth = createMcpAuth({
    db: database.db,
    identity: fakeGithub,
    config: {
      publicBaseUrl: new URL(baseUrl),
      githubClientId: 'unused',
      githubClientSecret: 'unused',
      allowedGithubUserId: OWNER_ID,
      allowedRedirectUris: [CALLBACK],
    },
  });
  late.app = createApp({ db: database.db, auth });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await database.close();
  await testDb.container.stop();
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirectUris = [CALLBACK]) {
  return fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
    }),
  });
}

async function token(params: Record<string, string>) {
  return fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

/** Runs /authorize → (fake) GitHub → our callback; returns the final redirect to the client. */
async function login(clientId: string, challenge: string): Promise<URL> {
  const authorize = new URL(`${baseUrl}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${baseUrl}/mcp`,
  }).toString();

  const toGithub = await fetch(authorize, { redirect: 'manual' });
  expect(toGithub.status).toBe(302);
  const githubUrl = new URL(toGithub.headers.get('location') ?? '');
  expect(githubUrl.origin).toBe('https://github.example');

  const callback = new URL(`${baseUrl}/oauth/github/callback`);
  callback.search = new URLSearchParams({
    code: 'github-code',
    state: githubUrl.searchParams.get('state') ?? '',
  }).toString();
  const toClient = await fetch(callback, { redirect: 'manual' });
  expect(toClient.status).toBe(302);
  return new URL(toClient.headers.get('location') ?? '');
}

async function loginAndGetTokens() {
  const { client_id: clientId } = (await (await register()).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const code = (await login(clientId, challenge)).searchParams.get('code') ?? '';
  const res = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CALLBACK,
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { clientId, code, verifier, ...tokens };
}

describe('OAuth for /mcp', () => {
  it('advertises protected resource metadata and rejects requests without a token', async () => {
    const metadata = (await (
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(metadata.resource).toBe(`${baseUrl}/mcp`);

    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('only registers clients with allowed redirect URIs', async () => {
    expect((await register(['https://attacker.example/cb'])).status).toBe(400);
    expect((await register()).status).toBe(201);
  });

  it('completes the flow for the owner and gives access to the MCP tools', async () => {
    const { access_token: accessToken } = await loginAndGetTokens();

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBe(7);
    await client.close();
  });

  it('passes the client state through and denies other GitHub users', async () => {
    const { client_id: clientId } = (await (await register()).json()) as { client_id: string };
    loggedInUserId = 1111;
    try {
      const redirect = await login(clientId, pkce().challenge);
      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.get('state')).toBe('client-state');
      expect(redirect.searchParams.has('code')).toBe(false);
    } finally {
      loggedInUserId = OWNER_ID;
    }
  });

  it('accepts an authorization code only once and only with the right PKCE verifier', async () => {
    const { clientId, code, verifier } = await loginAndGetTokens();
    const reuse = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);

    const { client_id: otherClient } = (await (await register()).json()) as { client_id: string };
    const freshCode = (await login(otherClient, pkce().challenge)).searchParams.get('code') ?? '';
    const wrongVerifier = await token({
      grant_type: 'authorization_code',
      code: freshCode,
      code_verifier: pkce().verifier,
      client_id: otherClient,
    });
    expect(wrongVerifier.status).toBe(400);
  });

  it('rotates refresh tokens', async () => {
    const { clientId, refresh_token: refreshToken } = await loginAndGetTokens();
    const refresh = (value: string) =>
      token({ grant_type: 'refresh_token', refresh_token: value, client_id: clientId });

    const first = await refresh(refreshToken);
    expect(first.status).toBe(200);
    expect((await refresh(refreshToken)).status).toBe(400);

    const { access_token: accessToken } = (await first.json()) as { access_token: string };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects unknown and revoked access tokens', async () => {
    const { clientId, access_token: accessToken } = await loginAndGetTokens();
    const call = () =>
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { Authorization: 'Bearer not-a-real-token' },
        })
      ).status,
    ).toBe(401);

    await fetch(`${baseUrl}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken, client_id: clientId }),
    });
    expect((await call()).status).toBe(401);
  });

  it('rejects a login callback with an unknown state', async () => {
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=github-code&state=forged`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });
});
