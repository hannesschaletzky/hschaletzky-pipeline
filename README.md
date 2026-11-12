# hschaletzky-pipeline

Tracks freelance project applications made through agencies and project portals, and flags
postings that are likely the same end-client project before you apply twice.

## Problem

Large freelance projects are often advertised by several agencies at once. Being put forward to the
same end client by two agencies usually ends in a rejection. Status, contacts, cover letters and CV
variants per application are also easy to lose track of.

## Solution

Applications and their history live in PostgreSQL. Before applying, a duplicate check compares the
new posting with existing ones (end client, location + start date + tech stack, text similarity).
Claude connects through an MCP server, so checks and updates happen directly in claude.ai.

## Architecture

<!-- TODO (milestone 3): diagram -->

```
src/
  domain/   pure business logic (status transitions, duplicate scoring) — no I/O
  db/       Drizzle schema, client, migrations runner
  http/     Express app (health; OAuth and /mcp in milestone 2)
  config.ts environment validation
drizzle/    versioned SQL migrations (generated, committed)
docs/adr/   architecture decision records
```

Stack: TypeScript (strict), Node.js, Express 5, PostgreSQL 18, Drizzle ORM, Vitest, Testcontainers.

## Quickstart (local)

Requirements: Node.js 26 (see `.nvmrc`), Docker, [gitleaks](https://github.com/gitleaks/gitleaks)
for the pre-commit hook.

```sh
npm install              # also activates the gitleaks pre-commit hook
cp .env.example .env     # placeholder credentials for local use
npm run db:up            # Postgres on 127.0.0.1:5432
npm run db:migrate
npm run dev              # http://localhost:3000/health
```

Checks:

```sh
npm run lint
npm run typecheck
npm test                 # unit + integration (starts a Postgres container)
```

`npm run db:migrate` applies migrations as the owner role and creates or updates the
least-privilege app role (`pipeline_app`). It is idempotent: after changing `APP_DB_PASSWORD`, just
run it again.

After changing `src/db/schema.ts`, run `npm run db:generate` and commit the new migration. CI fails
if schema and migrations diverge.

## Connecting Claude (MCP)

<!-- TODO (milestone 2) -->

## Privacy and security

- The repository never contains real data. Tests and examples use invented names only.
- Postgres is not exposed publicly. The app connects with a role limited to reading and writing
  data; schema changes run separately with the owner role.
- Logs contain ids and counts, never names, e-mail addresses or posting texts.
- Contact details are deleted after a configurable period once applications are closed
  (`contacts.delete_after`).
- Secret scanning: gitleaks runs as a pre-commit hook and in CI over the full history.

<!-- TODO (milestone 2): authentication, backups -->

## Deployment

<!-- TODO (milestone 2): Docker image on ghcr.io, rollout via hschaletzky-infra -->

## License

[MIT](LICENSE)
