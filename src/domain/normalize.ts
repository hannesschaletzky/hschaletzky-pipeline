/**
 * Normalisation used for matching. Pure functions, no I/O.
 * Goal: the same company, place or technology written differently should compare equal.
 */

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Lowercase, German umlauts transliterated, other diacritics removed, whitespace collapsed. */
function base(value: string): string {
  return value
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Legal-form tokens that do not distinguish companies ("Muster GmbH" = "Muster"). */
const LEGAL_FORMS = new Set([
  'gmbh',
  'mbh',
  'ag',
  'se',
  'kg',
  'kgaa',
  'ohg',
  'ug',
  'ev',
  'co',
  'haftungsbeschraenkt',
  'ltd',
  'inc',
  'llc',
  'plc',
  'bv',
  'nv',
  'sa',
  'sarl',
]);

/** "Muster Consulting GmbH & Co. KG" → "muster consulting" */
export function normalizeOrganizationName(name: string): string {
  const tokens = base(name)
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter((t) => t !== '' && !LEGAL_FORMS.has(t));
  const normalized = tokens.join(' ');
  // A name made only of legal-form tokens would normalise to nothing; keep it recognisable.
  return normalized === '' ? base(name) : normalized;
}

/**
 * "Frankfurt am Main / remote" → "frankfurt am main". Only the first place is kept, because
 * postings usually list the main site first.
 */
export function normalizeLocation(location: string): string {
  const first = base(location).split(/[,/|;(]| - /)[0] ?? '';
  return first.replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * Two locations match if they are equal or one extends the other by whole words
 * ("frankfurt" vs "frankfurt am main"), but not on a shared first word alone.
 */
export function locationsMatch(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter} `);
}

const STACK_ALIASES: Record<string, string> = {
  js: 'javascript',
  ecmascript: 'javascript',
  ts: 'typescript',
  node: 'nodejs',
  'node.js': 'nodejs',
  'react.js': 'react',
  reactjs: 'react',
  'vue.js': 'vue',
  vuejs: 'vue',
  angularjs: 'angular',
  postgres: 'postgresql',
  psql: 'postgresql',
  k8s: 'kubernetes',
  golang: 'go',
  'c#': 'csharp',
  '.net': 'dotnet',
  'spring-boot': 'spring boot',
  springboot: 'spring boot',
  'amazon web services': 'aws',
  'microsoft azure': 'azure',
  'google cloud': 'gcp',
};

export function normalizeStackTerm(term: string): string {
  const t = base(term);
  return STACK_ALIASES[t] ?? t;
}

/** Normalised, de-duplicated, sorted. */
export function normalizeStack(terms: readonly string[]): string[] {
  return [...new Set(terms.map(normalizeStackTerm).filter((t) => t !== ''))].sort();
}
