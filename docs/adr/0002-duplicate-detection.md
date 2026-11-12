# ADR 0002: Rule-based duplicate detection

- Status: accepted
- Date: 2026-11-12

## Context

The same end-client project is often advertised by several agencies, usually without naming the
client and with rewritten text. Being presented to the same client twice tends to end in a
rejection. Before applying, we want a list of existing applications that may be the same project,
each with a reason a human can check quickly.

The risk only materialises once the end client has seen the profile. Applying to two agencies is
harmless; being forwarded twice is not.

## Decision

Rules in pure domain code (`src/domain/duplicates.ts`); the database only supplies candidates and
trigram similarity. A candidate matches if at least one rule fires; the score is the strongest rule.

| Rule                | Fires when                                                                              | Score          |
| ------------------- | --------------------------------------------------------------------------------------- | -------------- |
| Same posting        | same agency and same agency reference number                                            | 1.0            |
| Confirmed           | linked via `same_project_as_id` (transitively) to a match                               | as the match   |
| End client          | same normalised end-client name                                                         | 0.9            |
| Place, start, stack | same place, start ≤ 6 weeks apart, ≥ 60 % stack overlap (relative to the smaller stack) | 0.6–0.8        |
| Text                | `pg_trgm` similarity ≥ 0.5                                                              | the similarity |

Each match carries `risk: high` when the existing application is in a client-facing status
(`presented`, `interview`, `offer`, `won`). Results are sorted by risk, then score.

Normalisation (`src/domain/normalize.ts`) removes legal forms from company names, transliterates
umlauts, keeps the first place of a location and maps common technology aliases.

## Why not embeddings

Better recall on rewritten texts, but an external API (posting texts leaving the server) or a local
model (memory on a small server). At the expected volume, rules plus trigram similarity are
transparent and good enough. Revisit if real usage shows missed duplicates.

## Consequences

- Text similarity is a weak signal: in tests, rewritten postings of the same project scored ~0.6,
  different projects with similar agency boilerplate ~0.5. The threshold is deliberately low; a
  false warning costs a glance, a double presentation costs the project.
- All applications are loaded as candidates. Fine for hundreds or a few thousand rows; beyond that,
  pre-filter in SQL.
- Confirmed duplicates (`same_project_as_id`) make future checks deterministic.
