import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../../src/config.js';

describe('loadAppConfig', () => {
  it('parses a valid environment and defaults the port', () => {
    const config = loadAppConfig({ DATABASE_URL: 'postgres://app:secret@localhost:5432/pipeline' });
    expect(config.PORT).toBe(3000);
  });

  it('rejects non-postgres URLs', () => {
    expect(() => loadAppConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes values in error messages', () => {
    let message = '';
    try {
      loadAppConfig({ DATABASE_URL: 'postgres://app:secret@localhost/db', PORT: 'x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain('secret');
  });
});
