import { create } from 'zustand';
import type { ActiveAlarm } from '@watchkeeper/shared';
import { api } from '../api/client';

export type { ActiveAlarm };

interface AlarmState {
  alarms: ActiveAlarm[];
  upsert(a: ActiveAlarm): void;
  remove(id: string): void;
  replaceAll(list: ActiveAlarm[]): void;
}

const severity = { emergency: 3, alarm: 2, warn: 1 } as const;

export const useAlarms = create<AlarmState>((set) => ({
  alarms: [],
  upsert: (a) => set((s) => ({ alarms: [...s.alarms.filter((x) => x.id !== a.id), a] })),
  remove: (id) => set((s) => ({ alarms: s.alarms.filter((x) => x.id !== id) })),
  replaceAll: (list) => set({ alarms: list }),
}));

/** Active alarms from the backend: on load and after every reconnect, since events may have been missed. */
export async function loadActiveAlarms(): Promise<void> {
  try {
    useAlarms.getState().replaceAll(await api<ActiveAlarm[]>('/alarms/active'));
  } catch {
    // Offline: the banner keeps what it had.
  }
}

const snoozed = (a: ActiveAlarm, now: number) => a.snoozedUntil !== null && Date.parse(a.snoozedUntil) > now;

/** The alarm the banner shows: not snoozed, highest severity, newest first. */
export function topAlarm(alarms: ActiveAlarm[], now = Date.now()): ActiveAlarm | null {
  return (
    alarms
      .filter((a) => !snoozed(a, now))
      .sort((a, b) => severity[b.state] - severity[a.state] || b.raisedAt.localeCompare(a.raisedAt))[0] ?? null
  );
}
