import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadMigrationConfig } from '../config.js';
import { log } from '../log.js';
import { createDatabase } from './client.js';

/** Applies all pending migrations from ./drizzle using the owner role. */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, close } = createDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const { MIGRATION_DATABASE_URL } = loadMigrationConfig();
  await runMigrations(MIGRATION_DATABASE_URL);
  log.info('migrations applied');
}
