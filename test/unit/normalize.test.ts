import { describe, expect, it } from 'vitest';

import {
  locationsMatch,
  normalizeLocation,
  normalizeOrganizationName,
  normalizeStack,
} from '../../src/domain/normalize.js';

describe('normalizeOrganizationName', () => {
  it.each([
    ['Muster Consulting GmbH', 'muster consulting'],
    ['Muster Consulting GmbH & Co. KG', 'muster consulting'],
    ['MUSTER consulting', 'muster consulting'],
    ['Müller Versicherung AG', 'mueller versicherung'],
    ['Mueller Versicherung', 'mueller versicherung'],
    ['Beispiel-Bank SE', 'beispielbank'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOrganizationName(input)).toBe(expected);
  });

  it('keeps names that consist only of legal forms recognisable', () => {
    expect(normalizeOrganizationName('AG')).toBe('ag');
  });
});

describe('normalizeLocation / locationsMatch', () => {
  it('keeps only the first place', () => {
    expect(normalizeLocation('Frankfurt am Main / remote')).toBe('frankfurt am main');
    expect(normalizeLocation('München, Berlin')).toBe('muenchen');
    expect(normalizeLocation('Musterstadt (80 % remote)')).toBe('musterstadt');
  });

  it('matches equal places and whole-word extensions', () => {
    expect(locationsMatch('frankfurt', 'frankfurt am main')).toBe(true);
    expect(locationsMatch('musterstadt', 'musterstadt')).toBe(true);
  });

  it('does not match on a shared first word alone', () => {
    expect(locationsMatch('bad musterbach', 'bad beispielheim')).toBe(false);
    expect(locationsMatch('frankfurt', 'frankfurter tor')).toBe(false);
    expect(locationsMatch('', 'musterstadt')).toBe(false);
  });
});

describe('normalizeStack', () => {
  it('unifies aliases, removes duplicates and sorts', () => {
    expect(normalizeStack(['TS', 'Node.js', 'React', 'typescript', 'Postgres', ' K8s '])).toEqual([
      'kubernetes',
      'nodejs',
      'postgresql',
      'react',
      'typescript',
    ]);
  });
});
