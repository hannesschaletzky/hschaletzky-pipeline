import { readFile } from 'node:fs/promises';

export interface BackupStatus {
  /** Time of the last successful backup, or null if none is recorded (or the file is unreadable). */
  lastSuccessAt: string | null;
  /** Hours since then, one decimal; null without a recorded backup. */
  ageHours: number | null;
}

/**
 * Reads the status file the server's backup job writes after each successful run
 * (a single ISO 8601 timestamp). Never throws: a missing backup is a finding, not an error.
 */
export async function readBackupStatus(file: string, now = new Date()): Promise<BackupStatus> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return { lastSuccessAt: null, ageHours: null };
  }
  const time = new Date(content.trim());
  if (Number.isNaN(time.getTime())) return { lastSuccessAt: null, ageHours: null };
  const hours = (now.getTime() - time.getTime()) / (60 * 60 * 1000);
  return { lastSuccessAt: time.toISOString(), ageHours: Math.round(hours * 10) / 10 };
}
