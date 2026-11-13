import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMcpAuth } from '../../src/auth/index.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const ISSUER = 'https://auth.example.test';

let testDb: TestDatabase;
let database: DatabaseHandle;
let jwksServer: Server;
let appServer: Server;
let baseUrl: string;
let resource: string;
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signingKey: PrivateKey;
let unpublishedKey: PrivateKey;

async function listen(server: Server): Promise<string> {
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  database = createDatabase(testDb.appUrl);

  // A stand-in for the authorization server's JWKS endpoint.
  const keys = await generateKeyPair('EdDSA');
  signingKey = keys.privateKey;
  unpublishedKey = (await generateKeyPair('EdDSA')).privateKey;
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'key-1', alg: 'EdDSA' };
  jwksServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const jwksBase = await listen(jwksServer);

  // The resource URL must contain the port, which is only known after listening.
  const late: { handler?: RequestListener } = {};
  appServer = createServer((req, res) => late.handler?.(req, res));
  baseUrl = await listen(appServer);
  resource = `${baseUrl}/mcp`;
  const auth = createMcpAuth({
    config: {
      publicBaseUrl: new URL(baseUrl),
      issuer: ISSUER,
      jwksUrl: new URL(`${jwksBase}/jwks`),
    },
  });
  late.handler = createApp({ db: database.db, auth });
});

afterAll(async () => {
  await Promise.all([appServer, jwksServer].map((s) => new Promise((resolve) => s.close(resolve))));
  await database.close();
  await testDb.container.stop();
});

interface TokenOptions {
  audience?: string;
  issuer?: string;
  typ?: string;
  key?: 'published' | 'unpublished';
  expiresIn?: string;
}

/** An access token as hschaletzky-auth issues it (RFC 9068 JWT), with deviations on request. */
function accessToken({
  audience = resource,
  issuer = ISSUER,
  typ = 'at+jwt',
  key = 'published',
  expiresIn = '1h',
}: TokenOptions = {}): Promise<string> {
  return new SignJWT({ azp: 'test-client' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1', typ })
    .setSubject('user-1')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key === 'published' ? signingKey : unpublishedKey);
}

const callMcp = (token?: string) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('/mcp as OAuth resource server', () => {
  it('publishes protected resource metadata pointing to the authorization server', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const metadata = (await (await fetch(`${baseUrl}${path}`)).json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({ resource, authorization_servers: [ISSUER] });
    }
  });

  it('challenges requests without a token with the metadata location', async () => {
    const res = await callMcp();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('serves the MCP tools with a valid access token', async () => {
    const token = await accessToken();
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(7);
    await client.close();
  });

  it.each<[string, TokenOptions]>([
    ['a token for another resource', { audience: 'https://other.example.test/mcp' }],
    ['a token from another issuer', { issuer: 'https://evil.example.test' }],
    ['a JWT that is not an access token', { typ: 'JWT' }],
    ['a key the issuer does not publish', { key: 'unpublished' }],
    ['an expired token', { expiresIn: '-1m' }],
  ])('rejects %s', async (_case, options) => {
    const res = await callMcp(await accessToken(options));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rejects malformed tokens', async () => {
    expect((await callMcp('not-a-jwt')).status).toBe(401);
  });
});
