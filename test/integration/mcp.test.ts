import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

// All data below is invented.
let testDb: TestDatabase;
let database: DatabaseHandle;
const servers: Server[] = [];

async function listen(bearer?: RequestHandler): Promise<string> {
  const auth = bearer && { routes: passThrough, bearer };
  const server = createApp({ db: database.db, auth }).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const passThrough: RequestHandler = (_req, _res, next) => {
  next();
};
const allowAll = passThrough;

let client: Client;
let baseUrl: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  database = createDatabase(testDb.appUrl);
  baseUrl = await listen(allowAll);
  client = await connect('auto');
});

/** 'auto' negotiates the current protocol (2026-07-28), 'legacy' uses the 2025 initialize handshake. */
async function connect(mode: 'auto' | 'legacy'): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return c;
}

afterAll(async () => {
  await client.close();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await database.close();
  await testDb.container.stop();
});

/** Calls a tool and parses its JSON text result. */
async function call<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  if (result.isError) throw new Error(`tool error: ${content?.text ?? ''}`);
  return JSON.parse(content?.text ?? 'null') as T;
}

describe('MCP endpoint', () => {
  it('is not mounted without authentication', async () => {
    const baseUrl = await listen();
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('is guarded by the auth middleware', async () => {
    const baseUrl = await listen((_req, res) => {
      res.status(401).end();
    });
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('speaks the current protocol and still serves 2025-era clients', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const legacy = await connect('legacy');
    try {
      expect(legacy.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect((await legacy.listTools()).tools).toHaveLength(7);
    } finally {
      await legacy.close();
    }
  });

  it('answers server/discover from 2026-07-28 clients', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { supportedVersions?: string[] } };
    expect(JSON.stringify(body.result)).toContain('2026-07-28');
  });

  it('offers the seven tools and usage instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_application',
      'check_duplicate',
      'get_application',
      'import_seed',
      'list_applications',
      'update_application',
      'update_status',
    ]);
    expect(client.getInstructions()).toMatch(/check_duplicate/);
  });
});

describe('MCP tools', () => {
  it('runs the full workflow: check, add, update, get, list', async () => {
    const posting = {
      title: 'Senior Fullstack Developer',
      agency: 'Muster Consulting GmbH',
      end_client: 'Beispiel Versicherung AG',
      location: 'Musterstadt',
      start_date: '2027-03-01',
      stack: ['TypeScript', 'React'],
    };

    expect(await call('check_duplicate', posting)).toEqual({ matches: [] });

    const { id } = await call<{ id: number }>('add_application', {
      ...posting,
      contact: { name: 'Max Mustermann', email: 'max@example.com' },
    });

    await call('update_status', { id, status: 'applied' });
    await call('update_status', { id, status: 'presented', note: 'Profile sent to client' });
    await call('update_application', { id, rate_eur: 760, rate_unit: 'day' });

    const application = await call('get_application', { id });
    expect(application).toMatchObject({
      status: 'presented',
      rateEur: 760,
      rateUnit: 'day',
      contact: { name: 'Max Mustermann' },
    });

    const { applications } = await call<{ applications: { id: number }[] }>('list_applications', {
      status: ['presented'],
    });
    expect(applications.map((a) => a.id)).toContain(id);

    // The same project via another agency: flagged as high risk.
    const { matches } = await call<{ matches: { applicationId: number; risk: string }[] }>(
      'check_duplicate',
      { end_client: 'Beispiel Versicherung', agency: 'Beispiel Personal AG' },
    );
    expect(matches).toEqual([expect.objectContaining({ applicationId: id, risk: 'high' })]);
  });

  it('warns about duplicates when adding without checking first', async () => {
    const { possibleDuplicates } = await call<{ possibleDuplicates: unknown[] }>(
      'add_application',
      { title: 'Fullstack Dev', end_client: 'Beispiel Versicherung AG' },
    );
    expect(possibleDuplicates.length).toBeGreaterThan(0);
  });

  it('returns readable errors for invalid input', async () => {
    await expect(call('update_status', { id: 999_999, status: 'applied' })).rejects.toThrow(
      'Application 999999 not found',
    );
    await expect(
      call('add_application', { title: 'X', start_date: '2027-05-01', end_date: '2027-01-01' }),
    ).rejects.toThrow(/end date before start date/);
    await expect(call('add_application', { title: 'X', start_date: '01.03.2027' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('refuses a seed import into a non-empty database', async () => {
    await expect(call('import_seed', { entries: [{ title: 'Imported project' }] })).rejects.toThrow(
      /already contains/,
    );

    const { imported } = await call<{ imported: number }>('import_seed', {
      entries: [{ title: 'Imported A', status: 'rejected' }, { title: 'Imported B' }],
      allow_existing: true,
    });
    expect(imported).toBe(2);
  });
});
