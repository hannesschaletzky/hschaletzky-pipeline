import { describe, expect, it } from 'vitest';

import {
  APPLICATION_STATUSES,
  CLOSED_STATUSES,
  canTransition,
  closedAtAfter,
  isClientFacing,
  isClosed,
} from '../../src/domain/status.js';

describe('application status', () => {
  it('treats exactly won, rejected, withdrawn and skipped as closed', () => {
    const closed = APPLICATION_STATUSES.filter(isClosed);
    expect(closed).toEqual([...CLOSED_STATUSES]);
  });

  it.each([
    ['interesting', 'applied'],
    ['interesting', 'won'],
    ['rejected', 'presented'],
    ['skipped', 'interesting'],
    ['won', 'withdrawn'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('flags statuses in which the end client has seen the profile', () => {
    expect(APPLICATION_STATUSES.filter(isClientFacing)).toEqual([
      'presented',
      'interview',
      'offer',
      'won',
    ]);
  });

  it('rejects a change to the same status', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('closedAtAfter', () => {
  const now = new Date('2027-03-01T10:00:00Z');
  const earlier = new Date('2027-02-01T10:00:00Z');

  it('sets closed_at when closing', () => {
    expect(closedAtAfter('rejected', null, now)).toBe(now);
  });

  it('keeps the original closing time when moving between closed statuses', () => {
    expect(closedAtAfter('withdrawn', earlier, now)).toBe(earlier);
  });

  it('clears closed_at when reopening', () => {
    expect(closedAtAfter('presented', earlier, now)).toBeNull();
  });
});
