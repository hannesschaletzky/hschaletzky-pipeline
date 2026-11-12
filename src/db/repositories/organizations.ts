import { and, eq, sql } from 'drizzle-orm';

import { normalizeOrganizationName } from '../../domain/normalize.js';
import type { DbOrTx } from '../client.js';
import { contacts, organizations } from '../schema.js';

export type Executor = DbOrTx;

export type OrganizationKind = NonNullable<typeof organizations.$inferSelect.kind>;

/**
 * Finds an organisation by its normalised name or creates it. A known `kind` is never
 * overwritten; an unknown one is filled in.
 */
export async function resolveOrganization(
  db: Executor,
  name: string,
  kind: OrganizationKind | null,
): Promise<number> {
  const [row] = await db
    .insert(organizations)
    .values({ name: name.trim(), normalizedName: normalizeOrganizationName(name), kind })
    .onConflictDoUpdate({
      target: organizations.normalizedName,
      set: { kind: sql`coalesce(${organizations.kind}, excluded.kind)` },
    })
    .returning({ id: organizations.id });
  if (!row) throw new Error('organisation upsert returned no row');
  return row.id;
}

export interface ContactInput {
  name: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
}

/**
 * Finds a contact by organisation and name (case-insensitive) or creates it.
 * Given e-mail or phone values update the stored ones.
 */
export async function resolveContact(
  db: Executor,
  organizationId: number | null,
  input: ContactInput,
): Promise<number> {
  const name = input.name.trim();
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        organizationId === null
          ? sql`${contacts.organizationId} is null`
          : eq(contacts.organizationId, organizationId),
        sql`lower(${contacts.name}) = lower(${name})`,
      ),
    )
    .limit(1);

  const details = {
    ...(input.email != null && { email: input.email }),
    ...(input.phone != null && { phone: input.phone }),
  };

  if (existing) {
    if (Object.keys(details).length > 0) {
      await db.update(contacts).set(details).where(eq(contacts.id, existing.id));
    }
    return existing.id;
  }

  const [created] = await db
    .insert(contacts)
    .values({ organizationId, name, ...details })
    .returning({ id: contacts.id });
  if (!created) throw new Error('contact insert returned no row');
  return created.id;
}
