import { count } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { type NewApplication, createApplication } from '../db/repositories/applications.js';
import { applications } from '../db/schema.js';
import { InvalidInputError } from '../domain/errors.js';

/**
 * One-off import of existing applications. All-or-nothing: runs in a single transaction.
 * Refuses to run on a non-empty database unless explicitly allowed, so an accidental second
 * import does not create a copy of everything.
 */
export async function importSeed(
  db: Database,
  entries: readonly NewApplication[],
  { allowExisting = false } = {},
): Promise<{ imported: number; ids: number[] }> {
  if (entries.length === 0) throw new InvalidInputError('No entries to import');

  return db.transaction(async (tx) => {
    if (!allowExisting) {
      const [row] = await tx.select({ n: count() }).from(applications);
      if ((row?.n ?? 0) > 0) {
        throw new InvalidInputError(
          `Database already contains ${String(row?.n)} applications; ` +
            'set allow_existing to import anyway',
        );
      }
    }
    const ids: number[] = [];
    for (const entry of entries) {
      ids.push((await createApplication(tx, entry)).id);
    }
    return { imported: ids.length, ids };
  });
}
