import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/client.js';
import { APP_ROLE, runMigrations } from '../../src/db/migrate.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.container.stop();
});

async function canConnect(url: string): Promise<boolean> {
  const { db, close } = createDatabase(url);
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

describe('migration step', () => {
  it('is idempotent and rotates the app role password', async () => {
    const newPassword = 'rotated-app-password-0123456789';
    await runMigrations({ ownerUrl: testDb.ownerUrl, appPassword: newPassword });

    const newUrl = new URL(testDb.appUrl);
    newUrl.password = newPassword;

    expect(await canConnect(testDb.appUrl)).toBe(false);
    expect(await canConnect(newUrl.toString())).toBe(true);
  });

  it('gives the app role no administrative rights', async () => {
    const { db, close } = createDatabase(testDb.ownerUrl);
    try {
      const result = await db.execute(
        sql`select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = ${APP_ROLE}`,
      );
      expect(result.rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
    } finally {
      await close();
    }
  });
});
