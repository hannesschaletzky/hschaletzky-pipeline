import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { InvalidInputError, NotFoundError } from '../../domain/errors.js';
import { normalizeOrganizationName, normalizeStack } from '../../domain/normalize.js';
import {
  type ApplicationStatus,
  canTransition,
  closedAtAfter,
  isClosed,
} from '../../domain/status.js';
import type { Database } from '../client.js';
import { applicationEvents, applications, contacts, organizations } from '../schema.js';
import {
  type ContactInput,
  type Executor,
  resolveContact,
  resolveOrganization,
} from './organizations.js';

const agency = alias(organizations, 'agency');
const endClient = alias(organizations, 'end_client');

type RateUnit = typeof applications.$inferInsert.rateUnit;

/** Editable fields. Organisations are given by name and created on first use. */
export interface ApplicationFields {
  title?: string;
  agency?: string | null;
  agencyProjectId?: string | null;
  contact?: ContactInput | null;
  endClient?: string | null;
  endClientHints?: string | null;
  location?: string | null;
  remoteShare?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  durationText?: string | null;
  stack?: string[];
  postingText?: string | null;
  coverLetter?: string | null;
  cvVariant?: string | null;
  rateEur?: number | null;
  rateUnit?: RateUnit;
  notes?: string | null;
  sameProjectAsId?: number | null;
}

export interface NewApplication extends ApplicationFields {
  title: string;
  status?: ApplicationStatus;
}

type Row = typeof applications.$inferInsert;

/** Maps input fields to column values, resolving organisations and contacts. */
async function toColumns(
  tx: Executor,
  fields: ApplicationFields,
  currentAgencyId: number | null,
): Promise<{ columns: Partial<Row>; contactId: number | null | undefined }> {
  const columns: Partial<Row> = {};
  const { agency: agencyName, endClient: endClientName, contact, stack, ...plain } = fields;

  // Optional fields may be explicitly undefined at runtime ("not given"); only copy given ones.
  for (const [key, value] of Object.entries(plain) as [string, unknown][]) {
    if (value !== undefined) (columns as Record<string, unknown>)[key] = value;
  }
  if (agencyName !== undefined) {
    columns.agencyId = agencyName === null ? null : await resolveOrganization(tx, agencyName, null);
  }
  if (endClientName !== undefined) {
    columns.endClientId =
      endClientName === null ? null : await resolveOrganization(tx, endClientName, 'end_client');
  }
  if (stack !== undefined) columns.stack = normalizeStack(stack);

  let contactId: number | null | undefined;
  if (contact !== undefined) {
    const organizationId = columns.agencyId !== undefined ? columns.agencyId : currentAgencyId;
    contactId = contact === null ? null : await resolveContact(tx, organizationId, contact);
    columns.contactId = contactId;
  }
  return { columns, contactId };
}

export async function createApplication(
  db: Database,
  input: NewApplication,
  now = new Date(),
): Promise<{ id: number }> {
  return db.transaction(async (tx) => {
    const { status = 'interesting', ...fields } = input;
    const { columns, contactId } = await toColumns(tx, fields, null);

    const [created] = await tx
      .insert(applications)
      .values({
        ...columns,
        title: input.title,
        status,
        closedAt: isClosed(status) ? now : null,
      })
      .returning({ id: applications.id });
    if (!created) throw new Error('application insert returned no row');

    await tx.insert(applicationEvents).values([
      {
        applicationId: created.id,
        type: 'status_change',
        payload: { type: 'status_change', from: null, to: status },
      },
      ...(contactId != null
        ? [
            {
              applicationId: created.id,
              type: 'contact' as const,
              payload: { type: 'contact' as const, contactId },
            },
          ]
        : []),
    ]);
    return created;
  });
}

async function lockApplication(tx: Executor, id: number) {
  const [current] = await tx
    .select({
      id: applications.id,
      status: applications.status,
      closedAt: applications.closedAt,
      agencyId: applications.agencyId,
      contactId: applications.contactId,
    })
    .from(applications)
    .where(eq(applications.id, id))
    .for('update');
  if (!current) throw new NotFoundError('Application', id);
  return current;
}

/** Updates fields (not the status) and records which fields changed. */
export async function updateApplication(
  db: Database,
  id: number,
  fields: ApplicationFields,
): Promise<{ updated: string[] }> {
  const changed = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (changed.length === 0) throw new InvalidInputError('No fields to update');
  if (fields.sameProjectAsId === id) {
    throw new InvalidInputError('An application cannot be the same project as itself');
  }

  return db.transaction(async (tx) => {
    const current = await lockApplication(tx, id);
    const { columns, contactId } = await toColumns(tx, fields, current.agencyId);

    await tx.update(applications).set(columns).where(eq(applications.id, id));
    await tx.insert(applicationEvents).values({
      applicationId: id,
      type: 'update',
      payload: { type: 'update', fields: changed },
    });
    if (contactId != null && contactId !== current.contactId) {
      await tx.insert(applicationEvents).values({
        applicationId: id,
        type: 'contact',
        payload: { type: 'contact', contactId },
      });
    }
    return { updated: changed };
  });
}

/** Changes the status, keeps `closed_at` consistent and records the change (and an optional note). */
export async function updateStatus(
  db: Database,
  id: number,
  to: ApplicationStatus,
  note?: string,
  now = new Date(),
): Promise<{ from: ApplicationStatus; to: ApplicationStatus }> {
  return db.transaction(async (tx) => {
    const current = await lockApplication(tx, id);
    if (!canTransition(current.status, to)) {
      throw new InvalidInputError(`Application ${String(id)} already has status ${to}`);
    }
    await tx
      .update(applications)
      .set({ status: to, closedAt: closedAtAfter(to, current.closedAt, now) })
      .where(eq(applications.id, id));
    await tx.insert(applicationEvents).values([
      {
        applicationId: id,
        type: 'status_change',
        payload: { type: 'status_change', from: current.status, to },
      },
      ...(note
        ? [
            {
              applicationId: id,
              type: 'note' as const,
              payload: { type: 'note' as const, text: note },
            },
          ]
        : []),
    ]);
    return { from: current.status, to };
  });
}

export interface ListFilter {
  status?: ApplicationStatus[];
  /** Agency name; matched after normalisation. */
  agency?: string;
  /** ISO date; applications created on or after this day. */
  since?: string;
}

export async function listApplications(db: Database, filter: ListFilter = {}) {
  const conditions = [
    filter.status?.length ? inArray(applications.status, filter.status) : undefined,
    filter.agency ? eq(agency.normalizedName, normalizeOrganizationName(filter.agency)) : undefined,
    filter.since ? gte(applications.createdAt, new Date(filter.since)) : undefined,
  ];
  return db
    .select({
      id: applications.id,
      title: applications.title,
      status: applications.status,
      agency: agency.name,
      endClient: endClient.name,
      location: applications.location,
      startDate: applications.startDate,
      sameProjectAsId: applications.sameProjectAsId,
      createdAt: applications.createdAt,
      updatedAt: applications.updatedAt,
    })
    .from(applications)
    .leftJoin(agency, eq(agency.id, applications.agencyId))
    .leftJoin(endClient, eq(endClient.id, applications.endClientId))
    .where(and(...conditions))
    .orderBy(desc(applications.updatedAt));
}

export async function getApplication(db: Database, id: number) {
  const [row] = await db
    .select({
      application: applications,
      agency: agency.name,
      endClient: endClient.name,
      contact: { name: contacts.name, email: contacts.email, phone: contacts.phone },
    })
    .from(applications)
    .leftJoin(agency, eq(agency.id, applications.agencyId))
    .leftJoin(endClient, eq(endClient.id, applications.endClientId))
    .leftJoin(contacts, eq(contacts.id, applications.contactId))
    .where(eq(applications.id, id));
  if (!row) throw new NotFoundError('Application', id);

  const [events, related] = await Promise.all([
    db
      .select({
        createdAt: applicationEvents.createdAt,
        type: applicationEvents.type,
        payload: applicationEvents.payload,
      })
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, id))
      .orderBy(asc(applicationEvents.createdAt), asc(applicationEvents.id)),
    db
      .select({
        id: applications.id,
        title: applications.title,
        status: applications.status,
        agency: agency.name,
      })
      .from(applications)
      .leftJoin(agency, eq(agency.id, applications.agencyId))
      .where(
        or(
          eq(applications.sameProjectAsId, id),
          row.application.sameProjectAsId === null
            ? sql`false`
            : eq(applications.id, row.application.sameProjectAsId),
        ),
      ),
  ]);

  return {
    ...row.application,
    agency: row.agency,
    endClient: row.endClient,
    contact: row.contact?.name ? row.contact : null,
    events,
    sameProject: related,
  };
}

/** All applications as duplicate candidates, with posting-text similarity if a text is given. */
export async function loadDuplicateCandidates(db: Database, postingText: string | null) {
  return db
    .select({
      id: applications.id,
      title: applications.title,
      status: applications.status,
      agencyName: agency.normalizedName,
      agencyDisplayName: agency.name,
      agencyProjectId: applications.agencyProjectId,
      endClientName: endClient.normalizedName,
      location: applications.location,
      startDate: applications.startDate,
      stack: applications.stack,
      sameProjectAsId: applications.sameProjectAsId,
      textSimilarity:
        postingText === null
          ? sql<null>`null`
          : sql<number | null>`similarity(${applications.postingText}, ${postingText})::float8`,
    })
    .from(applications)
    .leftJoin(agency, eq(agency.id, applications.agencyId))
    .leftJoin(endClient, eq(endClient.id, applications.endClientId));
}
