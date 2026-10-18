import { create } from 'zustand';

export interface ActiveAlarm {
  id: string;
  title: string;
  message: string;
  state: 'warn' | 'alarm' | 'emergency';
  raisedAt: string;
  acked: boolean;
}

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

/** The alarm the banner shows: highest severity, newest first. */
export function topAlarm(alarms: ActiveAlarm[]): ActiveAlarm | null {
  return (
    [...alarms].sort((a, b) => severity[b.state] - severity[a.state] || b.raisedAt.localeCompare(a.raisedAt))[0] ?? null
  );
}
