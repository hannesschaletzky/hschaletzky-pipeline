/**
 * Application lifecycle. Pure domain logic — no I/O, no database imports.
 *
 * Transitions are deliberately permissive: real processes are messy (an agency comes back after a
 * rejection, a skipped posting becomes interesting again), so any status can follow any other.
 * Every change is recorded as an event, which keeps the history traceable.
 */

export const APPLICATION_STATUSES = [
  'interesting',
  'applied',
  /** Profile forwarded to the end client — from here on, a second agency must not present it again. */
  'presented',
  'interview',
  'offer',
  'won',
  'rejected',
  'withdrawn',
  'skipped',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that end an application. `closed_at` is set exactly when an application is in one of these. */
export const CLOSED_STATUSES = [
  'won',
  'rejected',
  'withdrawn',
  'skipped',
] as const satisfies readonly ApplicationStatus[];

export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

/**
 * Statuses in which the end client has seen the profile. A duplicate in one of these is the
 * critical case: presenting the same person twice via different agencies usually ends in a rejection.
 */
export const CLIENT_FACING_STATUSES = [
  'presented',
  'interview',
  'offer',
  'won',
] as const satisfies readonly ApplicationStatus[];

export function isClientFacing(status: ApplicationStatus): boolean {
  return (CLIENT_FACING_STATUSES as readonly ApplicationStatus[]).includes(status);
}

export function isClosed(status: ApplicationStatus): status is ClosedStatus {
  return (CLOSED_STATUSES as readonly ApplicationStatus[]).includes(status);
}

/** Any change to a different status is allowed, including reopening a closed application. */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from !== to;
}

/**
 * Value for `closed_at` after a status change: keeps the original closing time while the
 * application stays closed, sets it when closing, clears it when reopening.
 */
export function closedAtAfter(
  to: ApplicationStatus,
  currentClosedAt: Date | null,
  now: Date,
): Date | null {
  if (!isClosed(to)) return null;
  return currentClosedAt ?? now;
}
