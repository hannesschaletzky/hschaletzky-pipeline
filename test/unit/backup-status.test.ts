import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBackupStatus } from '../../src/services/backup-status.js';

function statusFile(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pipeline-backup-')), 'last-success');
  writeFileSync(file, content);
  return file;
}

const NOW = new Date('2027-06-01T12:00:00Z');

describe('readBackupStatus', () => {
  it('reports time and age of the last successful backup', async () => {
    expect(await readBackupStatus(statusFile('2027-06-01T02:30:00Z\n'), NOW)).toEqual({
      lastSuccessAt: '2027-06-01T02:30:00.000Z',
      ageHours: 9.5,
    });
  });

  it('reports no backup for a missing or unreadable file', async () => {
    const none = { lastSuccessAt: null, ageHours: null };
    expect(await readBackupStatus('/does/not/exist', NOW)).toEqual(none);
    expect(await readBackupStatus(statusFile('garbage'), NOW)).toEqual(none);
  });
});
