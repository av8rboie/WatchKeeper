import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ClockStatus {
  synced: boolean | null;
  source: string | null;
  offsetMs: number | null;
}

let cached: { at: number; value: ClockStatus } | null = null;

/**
 * Read chrony's sync state. `chronyc -c tracking` prints one CSV line; the
 * last field is the leap status, "Normal" when synchronised. Returns nulls
 * where chrony isn't available (dev machines).
 */
export async function clockStatus(): Promise<ClockStatus> {
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  let value: ClockStatus = { synced: null, source: null, offsetMs: null };
  if (process.platform === 'linux') {
    try {
      const { stdout } = await run('chronyc', ['-c', 'tracking'], { timeout: 1500 });
      value = parseChronyTracking(stdout);
    } catch {
      value = { synced: false, source: null, offsetMs: null };
    }
  }
  cached = { at: Date.now(), value };
  return value;
}

export function parseChronyTracking(csv: string): ClockStatus {
  const f = csv.trim().split(',');
  const refName = f[1] ?? null;
  const stratum = Number(f[2]);
  const offsetSec = Number(f[4]);
  const leap = f[f.length - 1]?.trim();
  return {
    synced: leap === 'Normal' && stratum > 0 && stratum < 16,
    source: refName && refName !== '' ? refName : null,
    offsetMs: Number.isFinite(offsetSec) ? offsetSec * 1000 : null,
  };
}

export function diskStatus(dir: string): { freeBytes: number | null; totalBytes: number | null } {
  try {
    const s = statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}
