import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { applicationEvents, applications, contacts, organizations } from '../../src/db/schema.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

// All data below is invented.
let testDb: TestDatabase;
let app: DatabaseHandle;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = createDatabase(testDb.appUrl);
});

afterAll(async () => {
  await app.close();
  await testDb.container.stop();
});

/** Unwraps the single row of an INSERT … RETURNING. */
function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1)
    throw new Error(`expected 1 row, got ${String(rows.length)}`);
  return row;
}

/** Asserts a query fails with the given Postgres SQLSTATE (drizzle wraps the driver error in `cause`). */
async function expectSqlState(query: Promise<unknown>, code: string) {
  const error: unknown = await query.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { cause?: { code?: string } }).cause?.code).toBe(code);
}

async function createAgency(name = 'Muster Consulting GmbH') {
  return single(
    await app.db
      .insert(organizations)
      .values({ name, normalizedName: name.toLowerCase(), kind: 'agency' })
      .returning(),
  );
}

describe('schema (as app role)', () => {
  it('stores an application with stack and events', async () => {
    const agency = await createAgency();
    const application = single(
      await app.db
        .insert(applications)
        .values({
          title: 'Senior TypeScript Developer',
          agencyId: agency.id,
          location: 'Musterstadt',
          stack: ['typescript', 'node', 'postgres'],
          startDate: '2027-01-01',
        })
        .returning(),
    );
    expect(application.status).toBe('interesting');

    await app.db.insert(applicationEvents).values({
      applicationId: application.id,
      type: 'status_change',
      payload: { type: 'status_change', from: 'interesting', to: 'applied' },
    });

    const events = await app.db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, application.id));
    expect(events).toHaveLength(1);
  });

  it('allows an application without an agency', async () => {
    const application = single(
      await app.db.insert(applications).values({ title: 'Direct portal posting' }).returning(),
    );
    expect(application.agencyId).toBeNull();
  });

  it('identifies organisations by name regardless of kind', async () => {
    await createAgency('Doppelrolle Projekte GmbH');
    await expectSqlState(
      app.db.insert(organizations).values({
        name: 'Doppelrolle Projekte GmbH',
        normalizedName: 'doppelrolle projekte gmbh',
        kind: 'portal',
      }),
      '23505',
    );
    const withoutKind = single(
      await app.db
        .insert(organizations)
        .values({ name: 'Unbekannt AG', normalizedName: 'unbekannt ag' })
        .returning(),
    );
    expect(withoutKind.kind).toBeNull();
  });

  it('links confirmed duplicates to the same project', async () => {
    const first = single(
      await app.db.insert(applications).values({ title: 'Cloud Architect' }).returning(),
    );
    const second = single(
      await app.db
        .insert(applications)
        .values({ title: 'Cloud Architect (via other agency)', sameProjectAsId: first.id })
        .returning(),
    );
    expect(second.sameProjectAsId).toBe(first.id);

    await expectSqlState(
      app.db
        .update(applications)
        .set({ sameProjectAsId: first.id })
        .where(eq(applications.id, first.id)),
      '23514',
    );
  });

  it('stores hourly and daily rates', async () => {
    const hourly = single(
      await app.db.insert(applications).values({ title: 'H', rateEur: 95 }).returning(),
    );
    const daily = single(
      await app.db
        .insert(applications)
        .values({ title: 'D', rateEur: 760, rateUnit: 'day' })
        .returning(),
    );
    expect([hourly.rateUnit, daily.rateUnit]).toEqual(['hour', 'day']);
  });

  it('allows contacts without an organisation', async () => {
    const contact = single(
      await app.db.insert(contacts).values({ name: 'Erika Musterfrau' }).returning(),
    );
    expect(contact.organizationId).toBeNull();
  });

  it('requires closed_at exactly for closed statuses', async () => {
    const agency = await createAgency('Beispiel Personal AG');
    await expectSqlState(
      app.db.insert(applications).values({ title: 'X', agencyId: agency.id, status: 'rejected' }),
      '23514',
    );
    await expectSqlState(
      app.db
        .insert(applications)
        .values({ title: 'X', agencyId: agency.id, status: 'applied', closedAt: new Date() }),
      '23514',
    );
    await expect(
      app.db
        .insert(applications)
        .values({ title: 'X', agencyId: agency.id, status: 'rejected', closedAt: new Date() }),
    ).resolves.toBeDefined();
  });

  it('rejects event payloads whose type does not match the event type', async () => {
    const agency = await createAgency('Fiktiv Projekte GmbH');
    const application = single(
      await app.db.insert(applications).values({ title: 'Y', agencyId: agency.id }).returning(),
    );
    await expectSqlState(
      app.db.insert(applicationEvents).values({
        applicationId: application.id,
        type: 'note',
        payload: { type: 'contact', contactId: 1 },
      }),
      '23514',
    );
  });

  it('keeps applications when a contact is deleted', async () => {
    const agency = await createAgency('Erika Muster Recruiting');
    const contact = single(
      await app.db
        .insert(contacts)
        .values({ organizationId: agency.id, name: 'Max Mustermann', email: 'max@example.com' })
        .returning(),
    );
    const application = single(
      await app.db
        .insert(applications)
        .values({ title: 'Z', agencyId: agency.id, contactId: contact.id })
        .returning(),
    );

    await app.db.delete(contacts).where(eq(contacts.id, contact.id));

    const [after] = await app.db
      .select()
      .from(applications)
      .where(eq(applications.id, application.id));
    expect(after?.contactId).toBeNull();
  });

  it('finds similar posting texts via pg_trgm', async () => {
    const [row] = await app.db
      .execute<{ score: number }>(
        sql`select similarity('Senior TypeScript Entwickler in Musterstadt', 'TypeScript Entwickler (Senior), Musterstadt') as score`,
      )
      .then((r) => r.rows);
    expect(row?.score).toBeGreaterThan(0.5);
  });

  it('denies schema changes to the app role', async () => {
    await expectSqlState(app.db.execute(sql`create table not_allowed (id int)`), '42501');
    await expectSqlState(app.db.execute(sql`drop table applications`), '42501');
  });
});
