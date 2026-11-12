import { describe, expect, it } from 'vitest';

import {
  type Candidate,
  type PostingFacts,
  assessCandidate,
  findDuplicates,
  stackOverlap,
} from '../../src/domain/duplicates.js';

// All data is invented.
const posting: PostingFacts = {
  agencyName: 'muster consulting',
  agencyProjectId: null,
  endClientName: null,
  location: 'musterstadt',
  startDate: '2027-03-01',
  stack: ['nodejs', 'react', 'typescript'],
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    title: 'Senior Fullstack Developer',
    status: 'applied',
    agencyName: 'beispiel personal',
    agencyDisplayName: 'Beispiel Personal AG',
    agencyProjectId: null,
    endClientName: null,
    location: 'beispielburg',
    startDate: '2027-09-01',
    stack: ['java'],
    textSimilarity: null,
    sameProjectAsId: null,
    ...overrides,
  };
}

describe('stackOverlap', () => {
  it('measures against the smaller stack', () => {
    expect(stackOverlap(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(1);
    expect(stackOverlap(['a', 'b', 'c'], ['a', 'x', 'y'])).toBeCloseTo(1 / 3);
    expect(stackOverlap([], ['a'])).toBe(0);
  });
});

describe('assessCandidate', () => {
  it('returns null when no rule fires', () => {
    expect(assessCandidate(posting, candidate())).toBeNull();
  });

  it('detects the same end client', () => {
    const match = assessCandidate(
      { ...posting, endClientName: 'beispielbank' },
      candidate({ endClientName: 'beispielbank' }),
    );
    expect(match?.score).toBe(0.9);
    expect(match?.reasons).toEqual(['same end client (beispielbank)']);
  });

  it('detects same place, close start and overlapping stack', () => {
    const match = assessCandidate(
      posting,
      candidate({
        location: 'musterstadt',
        startDate: '2027-04-01',
        stack: ['react', 'typescript', 'graphql'],
      }),
    );
    expect(match?.reasons).toEqual([
      '67 % stack overlap, musterstadt, start 2027-03-01 vs 2027-04-01',
    ]);
  });

  it('ignores the same place when the start is more than six weeks apart', () => {
    expect(
      assessCandidate(
        posting,
        candidate({ location: 'musterstadt', startDate: '2027-05-01', stack: posting.stack }),
      ),
    ).toBeNull();
  });

  it('ignores the same place and start when the stack differs', () => {
    expect(
      assessCandidate(
        posting,
        candidate({ location: 'musterstadt', startDate: '2027-03-01', stack: ['java', 'react'] }),
      ),
    ).toBeNull();
  });

  it('reports similar posting texts with their similarity as score', () => {
    const match = assessCandidate(posting, candidate({ textSimilarity: 0.59 }));
    expect(match?.score).toBe(0.59);
    expect(match?.reasons).toEqual(['similar posting text (59 %)']);
  });

  it('treats the same agency reference as the same posting', () => {
    const match = assessCandidate(
      { ...posting, agencyProjectId: 'P-4711' },
      candidate({ agencyName: 'muster consulting', agencyProjectId: 'P-4711' }),
    );
    expect(match?.score).toBe(1);
  });

  it('flags high risk when the end client has already seen the profile', () => {
    const facts = { endClientName: 'beispielbank' };
    expect(
      assessCandidate({ ...posting, ...facts }, candidate({ ...facts, status: 'presented' }))?.risk,
    ).toBe('high');
    expect(
      assessCandidate({ ...posting, ...facts }, candidate({ ...facts, status: 'applied' }))?.risk,
    ).toBe('normal');
  });
});

describe('findDuplicates', () => {
  it('includes applications confirmed as the same project as a match', () => {
    const matches = findDuplicates({ ...posting, endClientName: 'beispielbank' }, [
      candidate({ id: 1, endClientName: 'beispielbank' }),
      candidate({ id: 2, sameProjectAsId: 1, status: 'interview' }),
      candidate({ id: 3, sameProjectAsId: 2 }),
      candidate({ id: 4 }),
    ]);
    expect(matches.map((m) => m.applicationId)).toEqual([2, 1, 3]);
    expect(matches[0]?.reasons).toEqual(['confirmed same project as application 1']);
    expect(matches[0]?.risk).toBe('high');
  });

  it('sorts high risk first, then by score', () => {
    const matches = findDuplicates(posting, [
      candidate({ id: 1, textSimilarity: 0.8 }),
      candidate({ id: 2, textSimilarity: 0.55, status: 'offer' }),
      candidate({ id: 3, textSimilarity: 0.9 }),
    ]);
    expect(matches.map((m) => m.applicationId)).toEqual([2, 3, 1]);
  });
});
