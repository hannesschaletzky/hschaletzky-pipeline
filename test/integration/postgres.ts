import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { runMigrations } from '../../src/db/migrate.js';

const root = path.resolve(import.meta.dirname, '../..');

/** Reads the Postgres image from compose.yml so tests and local dev always use the same version. */
function postgresImage(): string {
  const compose = readFileSync(path.join(root, 'compose.yml'), 'utf8');
  const match = /image:\s*(postgres:\S+)/.exec(compose);
  if (!match?.[1]) throw new Error('No postgres image found in compose.yml');
  return match[1];
}

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Owner role — runs migrations, like in production. */
  ownerUrl: string;
  /** Least-privilege role the app connects with. */
  appUrl: string;
}

/** Starts Postgres with the same init script as compose.yml and applies all migrations. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const appPassword = 'test-app-password';
  const container = await new PostgreSqlContainer(postgresImage())
    .withDatabase('pipeline')
    .withUsername('pipeline')
    .withPassword('test-owner-password')
    .withEnvironment({ APP_DB_PASSWORD: appPassword })
    .withCopyFilesToContainer([
      {
        source: path.join(root, 'docker/postgres/init/01-app-role.sh'),
        target: '/docker-entrypoint-initdb.d/01-app-role.sh',
        mode: 0o755,
      },
    ])
    .start();

  const ownerUrl = container.getConnectionUri();
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'pipeline_app';
  appUrl.password = appPassword;

  await runMigrations(ownerUrl);
  return { container, ownerUrl, appUrl: appUrl.toString() };
}
