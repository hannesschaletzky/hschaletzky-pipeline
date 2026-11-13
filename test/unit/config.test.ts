import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAppConfig, loadMigrationConfig, resolveFileSecrets } from '../../src/config.js';

function secretFile(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pipeline-config-')), 'secret');
  writeFileSync(file, content);
  return file;
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected function to throw');
}

describe('loadAppConfig', () => {
  it('parses a valid environment and defaults the port', () => {
    const config = loadAppConfig({ DATABASE_URL: 'postgres://app:secret@localhost:5432/pipeline' });
    expect(config).toEqual({
      databaseUrl: 'postgres://app:secret@localhost:5432/pipeline',
      port: 3000,
      contactRetentionDays: null,
      auth: null,
      backupStatusFile: null,
    });
  });

  it('puts a password from a file into the connection URL', () => {
    const config = loadAppConfig({
      DATABASE_URL: 'postgres://app@db:5432/pipeline',
      DATABASE_PASSWORD_FILE: secretFile('p@ss/word\n'),
    });
    expect(decodeURIComponent(new URL(config.databaseUrl).password)).toBe('p@ss/word');
  });

  it('rejects non-postgres URLs', () => {
    expect(() => loadAppConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes values in error messages', () => {
    const message = errorMessage(() =>
      loadAppConfig({ DATABASE_URL: 'postgres://app:secret@localhost/db', PORT: 'x' }),
    );
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain('secret');
  });
});

describe('OAuth configuration', () => {
  const base = { DATABASE_URL: 'postgres://app:pw@localhost/pipeline' };
  const github = {
    PUBLIC_BASE_URL: 'https://pipeline.example.com',
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_ALLOWED_USER_ID: '12345',
  };

  it('is complete or absent, never partial', () => {
    expect(loadAppConfig({ ...base, ...github }).auth).toMatchObject({
      allowedGithubUserId: 12345,
      allowedRedirectUris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    });
    expect(() => loadAppConfig({ ...base, GITHUB_CLIENT_ID: 'gh-client' })).toThrow(
      /missing: PUBLIC_BASE_URL, GITHUB_CLIENT_SECRET, GITHUB_ALLOWED_USER_ID/,
    );
  });

  it('accepts a custom redirect URI list', () => {
    const config = loadAppConfig({
      ...base,
      ...github,
      OAUTH_REDIRECT_URIS: 'https://a.example/cb, https://b.example/cb',
    });
    expect(config.auth?.allowedRedirectUris).toEqual([
      'https://a.example/cb',
      'https://b.example/cb',
    ]);
  });
});

describe('loadMigrationConfig', () => {
  it('requires a sufficiently long app password', () => {
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: 'postgres://owner:pw@localhost/pipeline',
        APP_DB_PASSWORD: 'short',
      }),
    ).toThrow(/APP_DB_PASSWORD/);
  });

  it('manages the backup role only when a backup password is given', () => {
    const base = {
      MIGRATION_DATABASE_URL: 'postgres://owner:pw@localhost/pipeline',
      APP_DB_PASSWORD: 'app-password-0123456789',
    };
    expect(loadMigrationConfig(base).backupPassword).toBeNull();
    expect(
      loadMigrationConfig({
        ...base,
        BACKUP_DB_PASSWORD_FILE: secretFile('backup-password-0123\n'),
      }).backupPassword,
    ).toBe('backup-password-0123');
    expect(() => loadMigrationConfig({ ...base, BACKUP_DB_PASSWORD: 'short' })).toThrow(
      /BACKUP_DB_PASSWORD/,
    );
  });
});

describe('resolveFileSecrets', () => {
  it('reads X_FILE into X and strips one trailing newline', () => {
    const env = resolveFileSecrets({ TOKEN_FILE: secretFile('abc\n') }, ['TOKEN']);
    expect(env.TOKEN).toBe('abc');
  });

  it('refuses ambiguous configuration', () => {
    expect(() =>
      resolveFileSecrets({ TOKEN: 'a', TOKEN_FILE: secretFile('b') }, ['TOKEN']),
    ).toThrow(/either TOKEN or TOKEN_FILE/);
  });

  it('reports unreadable files without their content', () => {
    expect(() => resolveFileSecrets({ TOKEN_FILE: '/does/not/exist' }, ['TOKEN'])).toThrow(
      /Cannot read TOKEN_FILE/,
    );
  });
});
