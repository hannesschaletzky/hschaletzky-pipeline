import type { Database } from '../db/client.js';
import { loadDuplicateCandidates } from '../db/repositories/applications.js';
import { type DuplicateMatch, findDuplicates } from '../domain/duplicates.js';
import {
  normalizeLocation,
  normalizeOrganizationName,
  normalizeStack,
} from '../domain/normalize.js';

export interface DuplicateQuery {
  postingText?: string | null;
  agency?: string | null;
  agencyProjectId?: string | null;
  endClient?: string | null;
  location?: string | null;
  startDate?: string | null;
  stack?: string[];
  /** Leave this application out (when re-checking an existing one). */
  excludeId?: number;
}

/** Loads candidates and applies the duplicate rules from the domain layer. */
export async function checkDuplicates(
  db: Database,
  query: DuplicateQuery,
): Promise<DuplicateMatch[]> {
  const rows = await loadDuplicateCandidates(db, query.postingText ?? null);
  const candidates = rows
    .filter((row) => row.id !== query.excludeId)
    .map((row) => ({
      ...row,
      location: row.location === null ? null : normalizeLocation(row.location),
    }));

  return findDuplicates(
    {
      agencyName: query.agency ? normalizeOrganizationName(query.agency) : null,
      agencyProjectId: query.agencyProjectId ?? null,
      endClientName: query.endClient ? normalizeOrganizationName(query.endClient) : null,
      location: query.location ? normalizeLocation(query.location) : null,
      startDate: query.startDate ?? null,
      stack: normalizeStack(query.stack ?? []),
    },
    candidates,
  );
}
