import { and, isNotNull, lt, lte, or, sql } from 'drizzle-orm';

import type { DbOrTx } from '../db/client.js';
import { applications, contacts, oauthTokens } from '../db/schema.js';
import { CLOSED_STATUSES } from '../domain/status.js';
import { log } from '../log.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes contacts that are no longer needed (data minimisation):
 * - always: contacts whose `delete_after` date has passed;
 * - only if a retention period is configured and the contact has no explicit `delete_after`:
 *   contacts whose applications have all been closed for longer than that period, and contacts
 *   without any application created longer ago than that period.
 * Applications keep their history; their contact reference becomes null.
 */
export async function deleteExpiredContacts(
  db: DbOrTx,
  { retentionDays, now = new Date() }: { retentionDays: number | null; now?: Date },
): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const conditions = [and(isNotNull(contacts.deleteAfter), lte(contacts.deleteAfter, today))];

  if (retentionDays !== null) {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const closed = sql.raw(CLOSED_STATUSES.map((s) => `'${s}'`).join(', '));
    conditions.push(
      and(
        sql`${contacts.deleteAfter} is null`,
        or(
          // All applications closed, the last one before the cutoff.
          sql`exists (select 1 from ${applications} a where a.contact_id = ${contacts.id})
              and not exists (
                select 1 from ${applications} a
                where a.contact_id = ${contacts.id}
                  and (a.status not in (${closed}) or a.closed_at >= ${cutoff})
              )`,
          // Never linked to an application.
          and(
            sql`not exists (select 1 from ${applications} a where a.contact_id = ${contacts.id})`,
            lt(contacts.createdAt, cutoff),
          ),
        ),
      ),
    );
  }

  const deleted = await db
    .delete(contacts)
    .where(or(...conditions))
    .returning({ id: contacts.id });
  return deleted.length;
}

export async function deleteExpiredTokens(db: DbOrTx, now = new Date()): Promise<number> {
  const deleted = await db
    .delete(oauthTokens)
    .where(lt(oauthTokens.expiresAt, now))
    .returning({ hash: oauthTokens.tokenHash });
  return deleted.length;
}

/** Runs the cleanup now and then daily. Logs counts only. */
export function scheduleRetention(
  db: DbOrTx,
  retentionDays: number | null,
  intervalMs = DAY_MS,
): () => void {
  const run = async () => {
    try {
      const contactsDeleted = await deleteExpiredContacts(db, { retentionDays });
      const tokensDeleted = await deleteExpiredTokens(db);
      log.info('retention run', { contactsDeleted, tokensDeleted });
    } catch (error) {
      log.error('retention run failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
