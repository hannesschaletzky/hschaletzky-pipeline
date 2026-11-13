import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Secrets can be passed directly (`X=value`, convenient for local `.env` files) or as a file path
 * (`X_FILE=/run/secrets/x`, used in production with Docker Compose secrets, so values never show
 * up in `docker inspect` or the process environment).
 */

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

const appSchema = z.object({
  /** May contain the password (local) or omit it in favour of DATABASE_PASSWORD (production). */
  DATABASE_URL: postgresUrl,
  DATABASE_PASSWORD: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Optional: delete contacts automatically once all their applications have been closed for
   * this many days. Unset: only contacts with an explicit delete_after date are deleted.
   */
  CONTACT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),

  // Access to /mcp: tokens from an external authorization server (hschaletzky-auth).
  // Both or neither; without them /mcp is not served.
  /** Public origin of this service; the MCP resource is <PUBLIC_BASE_URL>/mcp. */
  PUBLIC_BASE_URL: z.url().optional(),
  /** Issuer of the access tokens, e.g. https://auth.example.com */
  AUTH_ISSUER: z.url().optional(),
  /** JWKS of the issuer. Default: <AUTH_ISSUER>/api/auth/jwks (Better Auth). */
  AUTH_JWKS_URL: z.url().optional(),

  /**
   * Optional: file the server's backup job writes the time of its last successful run to
   * (ISO 8601). /health then reports the backup age, so monitoring can alert on stale backups.
   */
  BACKUP_STATUS_FILE: z.string().min(1).optional(),
});

const migrationSchema = z.object({
  /** Owner role: applies migrations and manages the app role. */
  MIGRATION_DATABASE_URL: postgresUrl,
  MIGRATION_DATABASE_PASSWORD: z.string().min(1).optional(),
  /** Password the migration step sets for the least-privilege app role. */
  APP_DB_PASSWORD: z.string().min(16, 'must be at least 16 characters'),
  /** Optional: password for the read-only role used by backups (pg_dump). */
  BACKUP_DB_PASSWORD: z.string().min(16, 'must be at least 16 characters').optional(),
});

/** Values that may be passed as files. */
const SECRET_NAMES = [
  'DATABASE_PASSWORD',
  'MIGRATION_DATABASE_PASSWORD',
  'APP_DB_PASSWORD',
  'BACKUP_DB_PASSWORD',
];

export interface AuthConfig {
  publicBaseUrl: URL;
  /** Expected `iss` of access tokens (the authorization server). */
  issuer: string;
  jwksUrl: URL;
}

export interface AppConfig {
  databaseUrl: string;
  port: number;
  contactRetentionDays: number | null;
  /** null: OAuth not configured, /mcp is not served. */
  auth: AuthConfig | null;
  backupStatusFile: string | null;
}

export interface MigrationConfig {
  ownerUrl: string;
  appPassword: string;
  backupPassword: string | null;
}

type Env = Record<string, string | undefined>;

/** Replaces `X_FILE` entries with the file content as `X`. Fails if both are set. */
export function resolveFileSecrets(env: Env, names: readonly string[] = SECRET_NAMES): Env {
  const resolved = { ...env };
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (file === undefined) continue;
    if (env[name] !== undefined) {
      throw new Error(`Set either ${name} or ${name}_FILE, not both`);
    }
    try {
      resolved[name] = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`Cannot read ${name}_FILE (${file})`);
    }
  }
  return resolved;
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(resolveFileSecrets(env));
  if (!result.success) {
    // Only report variable names and issue types, never values: they may contain credentials.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

/** Puts a separately supplied password into a connection URL. */
function withPassword(url: string, password: string | undefined): string {
  if (password === undefined) return url;
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}

function authConfig(config: z.infer<typeof appSchema>): AuthConfig | null {
  const { PUBLIC_BASE_URL: publicBaseUrl, AUTH_ISSUER: issuer } = config;
  if (!publicBaseUrl && !issuer) return null;
  if (!publicBaseUrl || !issuer) {
    const missing = !publicBaseUrl ? 'PUBLIC_BASE_URL' : 'AUTH_ISSUER';
    throw new Error(`Incomplete auth configuration, missing: ${missing}`);
  }
  // The issuer is compared with the token's `iss` exactly, so normalise it to the bare origin
  // form Better Auth uses (no trailing slash).
  const normalisedIssuer = issuer.replace(/\/+$/, '');
  return {
    publicBaseUrl: new URL(publicBaseUrl),
    issuer: normalisedIssuer,
    jwksUrl: new URL(config.AUTH_JWKS_URL ?? `${normalisedIssuer}/api/auth/jwks`),
  };
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  const config = parse(appSchema, env);
  return {
    databaseUrl: withPassword(config.DATABASE_URL, config.DATABASE_PASSWORD),
    port: config.PORT,
    contactRetentionDays: config.CONTACT_RETENTION_DAYS ?? null,
    auth: authConfig(config),
    backupStatusFile: config.BACKUP_STATUS_FILE ?? null,
  };
}

export function loadMigrationConfig(env: Env = process.env): MigrationConfig {
  const config = parse(migrationSchema, env);
  return {
    ownerUrl: withPassword(config.MIGRATION_DATABASE_URL, config.MIGRATION_DATABASE_PASSWORD),
    appPassword: config.APP_DB_PASSWORD,
    backupPassword: config.BACKUP_DB_PASSWORD ?? null,
  };
}
