import path from 'node:path';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadMigrationConfig } from '../config.js';
import { log } from '../log.js';
import { createDatabase, type Database } from './client.js';

/** Role the application connects with. It may read and write data, nothing else. */
export const APP_ROLE = 'pipeline_app';

/** Role the nightly pg_dump connects with. It may only read, and its sessions are read-only. */
export const BACKUP_ROLE = 'pipeline_backup';

/**
 * Brings the database to the current schema and (re)configures the app and backup roles.
 * Runs as the owner role and is idempotent, so it is safe on every deploy:
 * changing a password only requires running it again.
 */
export async function runMigrations({
  ownerUrl,
  appPassword,
  backupPassword,
}: {
  ownerUrl: string;
  appPassword: string;
  /** Optional: without it, no backup role is managed (e.g. local development). */
  backupPassword?: string | null;
}): Promise<void> {
  const { db, close } = createDatabase(ownerUrl);
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
    await configureAppRole(db, appPassword);
    if (backupPassword) await configureBackupRole(db, backupPassword);
  } finally {
    await close();
  }
}

/**
 * Creates the app role if missing, sets its password and grants data access (DML) only.
 * Grants are re-applied after every migration, so new tables are covered automatically.
 */
async function configureAppRole(db: Database, password: string): Promise<void> {
  await db.transaction(async (tx) => {
    // DO blocks cannot take bind parameters: pass the password as a transaction-local setting,
    // and let format(%L) quote it inside Postgres.
    await tx.execute(sql`select set_config('pipeline.app_password', ${password}, true)`);
    await tx.execute(
      sql.raw(`
        do $$
        declare
          app_role constant text := '${APP_ROLE}';
        begin
          if not exists (select from pg_roles where rolname = app_role) then
            execute format('create role %I', app_role);
          end if;
          execute format('alter role %I with login password %L',
                         app_role, current_setting('pipeline.app_password'));

          execute format('revoke all on database %I from public', current_database());
          execute format('grant connect on database %I to %I', current_database(), app_role);
          revoke create on schema public from public;
          execute format('grant usage on schema public to %I', app_role);
          execute format('grant select, insert, update, delete on all tables in schema public to %I', app_role);
          execute format('grant usage, select on all sequences in schema public to %I', app_role);
        end $$`),
    );
  });
}

/**
 * Creates the backup role if missing, sets its password and grants read access to the
 * application tables and the migration journal (schema "drizzle"), so a dump is complete.
 */
async function configureBackupRole(db: Database, password: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('pipeline.backup_password', ${password}, true)`);
    await tx.execute(
      sql.raw(`
        do $$
        declare
          backup_role constant text := '${BACKUP_ROLE}';
          s text;
        begin
          if not exists (select from pg_roles where rolname = backup_role) then
            execute format('create role %I', backup_role);
          end if;
          execute format('alter role %I with login password %L',
                         backup_role, current_setting('pipeline.backup_password'));
          execute format('alter role %I set default_transaction_read_only = on', backup_role);

          execute format('grant connect on database %I to %I', current_database(), backup_role);
          foreach s in array array['public', 'drizzle'] loop
            execute format('grant usage on schema %I to %I', s, backup_role);
            execute format('grant select on all tables in schema %I to %I', s, backup_role);
            execute format('grant select on all sequences in schema %I to %I', s, backup_role);
          end loop;
        end $$`),
    );
  });
}

if (import.meta.main) {
  await runMigrations(loadMigrationConfig());
  log.info('migrations applied');
}
