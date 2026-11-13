import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/client.js';
import { APP_ROLE, BACKUP_ROLE, runMigrations } from '../../src/db/migrate.js';
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

  it('creates a read-only backup role that can run pg_dump', async () => {
    const appPassword = 'rotated-app-password-0123456789';
    const backupPassword = 'test-backup-password-0123456789';
    await runMigrations({ ownerUrl: testDb.ownerUrl, appPassword, backupPassword });

    const backupUrl = new URL(testDb.ownerUrl);
    backupUrl.username = BACKUP_ROLE;
    backupUrl.password = backupPassword;
    const { db, close } = createDatabase(backupUrl.toString());
    try {
      await expect(db.execute(sql`select count(*) from applications`)).resolves.toBeDefined();
      await expect(
        db.execute(sql`insert into organizations (name, normalized_name) values ('x', 'x')`),
      ).rejects.toThrow();
    } finally {
      await close();
    }

    const dump = await testDb.container.exec(
      ['pg_dump', '-h', '127.0.0.1', '-U', BACKUP_ROLE, '-d', 'pipeline', '--schema-only'],
      { env: { PGPASSWORD: backupPassword } },
    );
    expect(dump.exitCode).toBe(0);
    expect(dump.output).toContain('CREATE TABLE public.applications');
    expect(dump.output).toContain('CREATE TABLE drizzle.__drizzle_migrations');
  });
});
