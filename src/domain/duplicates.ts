/**
 * Duplicate detection: is a new posting likely the same end-client project as an existing
 * application? Pure functions — candidates are loaded by the data layer.
 *
 * A candidate matches if at least one rule fires; the score is the strongest rule.
 * Rules and thresholds are documented in docs/adr/0002-duplicate-detection.md.
 */

import { locationsMatch } from './normalize.js';
import { type ApplicationStatus, isClientFacing } from './status.js';

export const START_WINDOW_DAYS = 42;
export const MIN_STACK_OVERLAP = 0.6;
/**
 * pg_trgm similarity is a weak signal: rewritten postings of the same project scored ~0.6 in
 * tests, different projects with similar agency boilerplate ~0.5. Kept low on purpose — a false
 * warning is cheap, a double presentation is not.
 */
export const MIN_TEXT_SIMILARITY = 0.5;

/** Facts about the new posting, already normalised. */
export interface PostingFacts {
  agencyName: string | null;
  agencyProjectId: string | null;
  endClientName: string | null;
  location: string | null;
  startDate: string | null;
  stack: readonly string[];
}

/** An existing application, already normalised, plus its text similarity to the new posting. */
export interface Candidate extends PostingFacts {
  id: number;
  title: string;
  status: ApplicationStatus;
  /** Display name of the agency (not normalised). */
  agencyDisplayName: string | null;
  /** pg_trgm similarity of posting texts, null if either text is missing. */
  textSimilarity: number | null;
  sameProjectAsId: number | null;
}

export type Risk = 'high' | 'normal';

export interface DuplicateMatch {
  applicationId: number;
  title: string;
  status: ApplicationStatus;
  agency: string | null;
  /** 0–1, strongest rule that fired. */
  score: number;
  /**
   * high: the end client has already seen the profile through this application (presented,
   * interview, offer, won) — applying again via another agency is the case to avoid.
   */
  risk: Risk;
  reasons: string[];
}

/** Share of the smaller stack contained in the larger one (0–1). */
export function stackOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [smaller, larger] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return smaller.filter((t) => larger.has(t)).length / smaller.length;
}

export function daysBetween(isoDateA: string, isoDateB: string): number {
  const ms = Math.abs(Date.parse(isoDateA) - Date.parse(isoDateB));
  return Math.round(ms / 86_400_000);
}

const percent = (value: number) => `${String(Math.round(value * 100))} %`;

export function assessCandidate(
  posting: PostingFacts,
  candidate: Candidate,
): DuplicateMatch | null {
  const hits: { score: number; reason: string }[] = [];

  if (
    posting.agencyProjectId !== null &&
    posting.agencyProjectId === candidate.agencyProjectId &&
    posting.agencyName !== null &&
    posting.agencyName === candidate.agencyName
  ) {
    hits.push({
      score: 1,
      reason: `same agency reference ${posting.agencyProjectId} — this is the same posting`,
    });
  }

  if (posting.endClientName !== null && posting.endClientName === candidate.endClientName) {
    hits.push({ score: 0.9, reason: `same end client (${posting.endClientName})` });
  }

  if (
    posting.location !== null &&
    candidate.location !== null &&
    posting.startDate !== null &&
    candidate.startDate !== null &&
    locationsMatch(posting.location, candidate.location)
  ) {
    const days = daysBetween(posting.startDate, candidate.startDate);
    const overlap = stackOverlap(posting.stack, candidate.stack);
    if (days <= START_WINDOW_DAYS && overlap >= MIN_STACK_OVERLAP) {
      hits.push({
        score: 0.6 + 0.2 * overlap,
        reason:
          `${percent(overlap)} stack overlap, ${candidate.location}, ` +
          `start ${posting.startDate} vs ${candidate.startDate}`,
      });
    }
  }

  if (candidate.textSimilarity !== null && candidate.textSimilarity >= MIN_TEXT_SIMILARITY) {
    hits.push({
      score: candidate.textSimilarity,
      reason: `similar posting text (${percent(candidate.textSimilarity)})`,
    });
  }

  if (hits.length === 0) return null;
  return {
    applicationId: candidate.id,
    title: candidate.title,
    status: candidate.status,
    agency: candidate.agencyDisplayName,
    score: Math.round(Math.max(...hits.map((h) => h.score)) * 100) / 100,
    risk: isClientFacing(candidate.status) ? 'high' : 'normal',
    reasons: hits.map((h) => h.reason),
  };
}

/**
 * Assesses all candidates and adds applications confirmed as the same project
 * (`same_project_as_id`, transitively) as any match, even if no rule fires for them directly.
 * Sorted: high risk first, then by score.
 */
export function findDuplicates(
  posting: PostingFacts,
  candidates: readonly Candidate[],
): DuplicateMatch[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const matches = new Map<number, DuplicateMatch>();
  for (const candidate of candidates) {
    const match = assessCandidate(posting, candidate);
    if (match) matches.set(candidate.id, match);
  }

  for (const group of projectGroups(candidates)) {
    const matched = group.filter((id) => matches.has(id));
    if (matched.length === 0) continue;
    const score = Math.max(...matched.map((id) => matches.get(id)?.score ?? 0));
    for (const id of group) {
      const candidate = byId.get(id);
      if (matches.has(id) || !candidate) continue;
      matches.set(id, {
        applicationId: id,
        title: candidate.title,
        status: candidate.status,
        agency: candidate.agencyDisplayName,
        score,
        risk: isClientFacing(candidate.status) ? 'high' : 'normal',
        reasons: [`confirmed same project as application ${matched.map(String).join(', ')}`],
      });
    }
  }

  return [...matches.values()].sort(
    (a, b) => Number(b.risk === 'high') - Number(a.risk === 'high') || b.score - a.score,
  );
}

/** Connected components of the `same_project_as_id` links (only groups with 2+ members). */
export function projectGroups(candidates: readonly Candidate[]): number[][] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const { id, sameProjectAsId } of candidates) {
    if (sameProjectAsId !== null) parent.set(find(id), find(sameProjectAsId));
  }
  const groups = new Map<number, number[]>();
  for (const { id } of candidates) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
