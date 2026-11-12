import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApplication } from '../../src/db/repositories/applications.js';
import { applications, contacts } from '../../src/db/schema.js';
import type { ApplicationStatus } from '../../src/domain/status.js';
import { deleteExpiredContacts } from '../../src/services/retention.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

// All data below is invented.
let testDb: TestDatabase;
let handle: DatabaseHandle;
const db = () => handle.db;

const NOW = new Date('2027-06-01T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  testDb = await startTestDatabase();
  handle = createDatabase(testDb.appUrl);
});

beforeEach(async () => {
  await db().delete(applications);
  await db().delete(contacts);
});

afterAll(async () => {
  await handle.close();
  await testDb.container.stop();
});

/** Creates an application with a contact; closed applications get the given closing date. */
async function withContact(
  name: string,
  status: ApplicationStatus,
  closedAt?: Date,
  deleteAfter?: string,
) {
  const { id } = await createApplication(db(), {
    title: `Project of ${name}`,
    agency: 'Muster Consulting GmbH',
    status,
    contact: { name, deleteAfter },
  });
  if (closedAt) await db().update(applications).set({ closedAt }).where(eq(applications.id, id));
  return id;
}

async function remainingContacts(): Promise<string[]> {
  return (await db().select({ name: contacts.name }).from(contacts)).map((c) => c.name).sort();
}

describe('contact retention', () => {
  it('without a retention period, deletes only contacts whose delete_after has passed', async () => {
    await withContact('Anna Beispiel', 'applied', undefined, '2027-05-31');
    await withContact('Bert Beispiel', 'applied', undefined, '2027-06-02');
    await withContact('Carla Beispiel', 'rejected', daysAgo(1000));

    expect(await deleteExpiredContacts(db(), { retentionDays: null, now: NOW })).toBe(1);
    expect(await remainingContacts()).toEqual(['Bert Beispiel', 'Carla Beispiel']);
  });

  it('with a retention period, deletes contacts whose applications are all long closed', async () => {
    const appId = await withContact('Carla Beispiel', 'rejected', daysAgo(400));
    await withContact('Dora Beispiel', 'won', daysAgo(100));

    expect(await deleteExpiredContacts(db(), { retentionDays: 365, now: NOW })).toBe(1);
    expect(await remainingContacts()).toEqual(['Dora Beispiel']);

    // The application and its history stay; only the contact reference is gone.
    const [application] = await db()
      .select({ contactId: applications.contactId })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(application).toEqual({ contactId: null });
  });

  it('keeps contacts with any open application and contacts with an explicit future date', async () => {
    await withContact('Emil Beispiel', 'rejected', daysAgo(400));
    await withContact('Emil Beispiel', 'presented');
    await withContact('Frieda Beispiel', 'rejected', daysAgo(400), '2028-01-01');

    expect(await deleteExpiredContacts(db(), { retentionDays: 365, now: NOW })).toBe(0);
    expect(await remainingContacts()).toEqual(['Emil Beispiel', 'Frieda Beispiel']);
  });

  it('deletes old contacts that were never linked to an application', async () => {
    const [old] = await db()
      .insert(contacts)
      .values([
        { name: 'Gustav Beispiel', createdAt: daysAgo(400) },
        { name: 'Hanna Beispiel', createdAt: daysAgo(10) },
      ])
      .returning({ id: contacts.id });

    expect(await deleteExpiredContacts(db(), { retentionDays: 365, now: NOW })).toBe(1);
    const left = await db()
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, [old?.id ?? 0]));
    expect(left).toEqual([]);
  });
});
