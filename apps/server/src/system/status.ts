import { readFileSync, statfsSync } from 'node:fs';
import type { HaClient } from '../ha/client.js';

/** HA's system monitor CPU temperature sensor. Configurable in settings. */
export const DEFAULT_CPU_TEMP_ENTITY = 'sensor.system_monitor_processor_temperature';

let cachedTemp: { at: number; value: number | null } | null = null;

/**
 * CPU temperature in °C: HA's system monitor sensor first (the spec's
 * source), the kernel thermal zone as a fallback. Cached for 30 s.
 */
export async function cpuTemperature(ha: HaClient, entityId: string): Promise<number | null> {
  if (cachedTemp && Date.now() - cachedTemp.at < 30_000) return cachedTemp.value;
  let value: number | null = null;
  try {
    const s = await ha.getState(entityId);
    const n = s ? Number(s.state) : NaN;
    if (Number.isFinite(n)) value = n;
  } catch {
    // HA unreachable; try the kernel.
  }
  if (value === null) {
    try {
      const milli = Number(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());
      if (Number.isFinite(milli)) value = milli / 1000;
    } catch {
      // Not on Linux, or no thermal zone exposed.
    }
  }
  cachedTemp = { at: Date.now(), value };
  return value;
}

export function diskStatus(dir: string): { freeBytes: number | null; totalBytes: number | null } {
  try {
    const s = statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}
