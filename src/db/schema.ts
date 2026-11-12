import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { APPLICATION_STATUSES, CLOSED_STATUSES, type ApplicationStatus } from '../domain/status.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const organizationKind = pgEnum('organization_kind', ['agency', 'portal', 'end_client']);
export const applicationStatus = pgEnum('application_status', APPLICATION_STATUSES);
export const rateUnit = pgEnum('rate_unit', ['hour', 'day']);
export const applicationEventType = pgEnum('application_event_type', [
  'status_change',
  'note',
  'contact',
]);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Agencies, project portals and end clients. A name identifies an organisation; `kind` only
 * describes it, because some companies are agency and portal at once.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    name: text('name').notNull(),
    /** Normalised form of `name`, used to match end clients across postings. */
    normalizedName: text('normalized_name').notNull(),
    kind: organizationKind('kind'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [unique('organizations_normalized_name_key').on(t.normalizedName)],
);

/**
 * People at agencies and portals. Personal data: removed once `delete_after` has passed.
 * Applications reference contacts with ON DELETE SET NULL so deletion never breaks history.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    /** Optional: a recruiter may get in touch before it is clear whom they work for. */
    organizationId: integer('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    createdAt: createdAt(),
    deleteAfter: date('delete_after'),
  },
  (t) => [
    index('contacts_organization_id_idx').on(t.organizationId),
    index('contacts_delete_after_idx').on(t.deleteAfter),
  ],
);

const closedStatusList = sql.raw(CLOSED_STATUSES.map((s) => `'${s}'`).join(', '));

export const applications = pgTable(
  'applications',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    title: text('title').notNull(),
    status: applicationStatus('status').notNull().default('interesting'),

    /** Agency or portal the application went through. Optional, e.g. when not yet known. */
    agencyId: integer('agency_id').references(() => organizations.id, { onDelete: 'set null' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** The agency's own reference number for the posting. */
    agencyProjectId: text('agency_project_id'),

    endClientId: integer('end_client_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    /**
     * Marks this application as the same end-client project as another one (a confirmed duplicate).
     * Point all duplicates at the first application of the project.
     */
    sameProjectAsId: integer('same_project_as_id').references((): AnyPgColumn => applications.id, {
      onDelete: 'set null',
    }),
    /** Free-text clues about the end client when the agency does not name it ("large insurer, Munich"). */
    endClientHints: text('end_client_hints'),

    location: text('location'),
    /** Remote share in percent (0–100). */
    remoteShare: smallint('remote_share'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    durationText: text('duration_text'),

    /** Normalised technology terms, used for duplicate detection. */
    stack: text('stack')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    postingText: text('posting_text'),

    coverLetter: text('cover_letter'),
    cvVariant: text('cv_variant'),
    /** Rate in whole euros per `rate_unit` (hourly or daily rate). */
    rateEur: integer('rate_eur'),
    rateUnit: rateUnit('rate_unit').notNull().default('hour'),
    notes: text('notes'),
  },
  (t) => [
    index('applications_status_idx').on(t.status),
    index('applications_agency_id_idx').on(t.agencyId),
    index('applications_end_client_id_idx').on(t.endClientId),
    index('applications_contact_id_idx').on(t.contactId),
    index('applications_same_project_as_id_idx').on(t.sameProjectAsId),
    index('applications_stack_idx').using('gin', t.stack),
    index('applications_posting_text_trgm_idx').using('gin', t.postingText.op('gin_trgm_ops')),
    check(
      'applications_closed_at_matches_status',
      sql`(${t.status} in (${closedStatusList})) = (${t.closedAt} is not null)`,
    ),
    check(
      'applications_remote_share_range',
      sql`${t.remoteShare} is null or ${t.remoteShare} between 0 and 100`,
    ),
    check('applications_not_same_project_as_itself', sql`${t.sameProjectAsId} <> ${t.id}`),
    check('applications_rate_eur_positive', sql`${t.rateEur} is null or ${t.rateEur} > 0`),
    check(
      'applications_date_order',
      sql`${t.startDate} is null or ${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/**
 * Event payloads reference other rows by id only. They must never copy personal data
 * (names, e-mails), otherwise it would survive contact deletion.
 */
export type ApplicationEventPayload =
  | { type: 'status_change'; from: ApplicationStatus; to: ApplicationStatus }
  | { type: 'note'; text: string }
  | { type: 'contact'; contactId: number };

export const applicationEvents = pgTable(
  'application_events',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    type: applicationEventType('type').notNull(),
    payload: jsonb('payload').$type<ApplicationEventPayload>().notNull(),
  },
  (t) => [
    index('application_events_application_id_created_at_idx').on(t.applicationId, t.createdAt),
    check('application_events_payload_type_matches', sql`${t.payload}->>'type' = ${t.type}::text`),
  ],
);
