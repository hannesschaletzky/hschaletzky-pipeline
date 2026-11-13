import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

let testDb: TestDatabase;
let database: DatabaseHandle;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  database = createDatabase(testDb.appUrl);
  server = createApp({ db: database.db }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await database.close();
  await testDb.container.stop();
});

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('reports the backup age when a backup status file is configured', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'pipeline-health-')), 'last-success');
    writeFileSync(file, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    const withBackup = createApp({ db: database.db, backupStatusFile: file }).listen(0);
    await new Promise<void>((resolve) => withBackup.once('listening', resolve));
    try {
      const port = String((withBackup.address() as AddressInfo).port);
      const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        status: string;
        backup: { ageHours: number };
      };
      expect(body.status).toBe('ok');
      expect(body.backup.ageHours).toBe(3);
    } finally {
      await new Promise((resolve) => withBackup.close(resolve));
    }
  });
});
