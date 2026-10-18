import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { describePath, effectiveStaleMs, type LiveMessage, type ServerEvent, type SystemStatus } from '@watchkeeper/shared';
import { wsUrl } from '../api/base';
import { useAlarms, type ActiveAlarm } from '../shell/alarms';

export type Connection = 'connecting' | 'open' | 'reconnecting';

interface Entry {
  value: unknown;
  /** Server time of the value. */
  ts: number;
  /** Server time when the batch was sent. */
  serverNow: number;
  /** Local time when the batch arrived. */
  received: number;
}

interface LiveState {
  connection: Connection;
  values: Record<string, Entry>;
}

export const useLive = create<LiveState>(() => ({ connection: 'connecting', values: {} }));

type EventListener = (ev: ServerEvent) => void;

/**
 * The one Data Hub WebSocket. Components retain the paths they show; the
 * union goes to the server as `live.subscribe`. The server batches updates
 * to at most 4 per second, so widgets never re-render faster than that.
 */
class DataHubSocket {
  private ws: WebSocket | null = null;
  private readonly refs = new Map<string, number>();
  private readonly listeners = new Set<EventListener>();
  private subTimer: number | undefined;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl('/events'));
    this.ws = ws;
    ws.onopen = () => {
      useLive.setState({ connection: 'open' });
      this.sendSubscription();
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => {
      // Keep the last values on screen; they go stale as their timeouts pass.
      useLive.setState({ connection: 'reconnecting' });
      window.setTimeout(() => this.connect(), 2000);
    };
  }

  private onMessage(text: string): void {
    let msg: LiveMessage | ServerEvent;
    try {
      msg = JSON.parse(text) as LiveMessage | ServerEvent;
    } catch {
      return;
    }
    if (msg.type === 'live') {
      const received = Date.now();
      const live = msg as LiveMessage;
      const next: Record<string, Entry> = {};
      for (const [path, [value, ts]] of Object.entries(live.values)) next[path] = { value, ts, serverNow: live.now, received };
      useLive.setState((s) => ({ values: { ...s.values, ...next } }));
      return;
    }
    for (const l of this.listeners) l(msg as ServerEvent);
  }

  /** Show these paths; returns a release function. */
  retain(paths: string[]): () => void {
    for (const p of paths) this.refs.set(p, (this.refs.get(p) ?? 0) + 1);
    this.scheduleSubscription();
    return () => {
      for (const p of paths) {
        const n = (this.refs.get(p) ?? 1) - 1;
        if (n <= 0) this.refs.delete(p);
        else this.refs.set(p, n);
      }
      this.scheduleSubscription();
    };
  }

  onEvent(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private scheduleSubscription(): void {
    window.clearTimeout(this.subTimer);
    this.subTimer = window.setTimeout(() => this.sendSubscription(), 50);
  }

  private sendSubscription(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'live.subscribe', paths: [...this.refs.keys()] }));
  }
}

export const socket = new DataHubSocket();

/** Re-render on an interval so ages and staleness advance without new data. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface LiveReading {
  value: unknown;
  ageMs: number | null;
  stale: boolean;
}

/**
 * Age is measured on the server's clock plus local time since receipt, so a
 * phone with a wrong clock still judges staleness right.
 */
export function readEntry(path: string, e: Entry | undefined, now: number): LiveReading {
  if (!e) return { value: null, ageMs: null, stale: true };
  const ageMs = Math.max(0, e.serverNow - e.ts + (now - e.received));
  const timeout = effectiveStaleMs(describePath(path, e.value));
  return { value: e.value, ageMs, stale: timeout !== null && ageMs > timeout };
}

export function useLiveValues(paths: string[]): Record<string, LiveReading> {
  const key = paths.join('\n');
  useEffect(() => socket.retain(key ? key.split('\n') : []), [key]);
  const values = useLive((s) => s.values);
  const now = useNow(1000);
  const out: Record<string, LiveReading> = {};
  for (const p of paths) out[p] = readEntry(p, values[p], now);
  return out;
}

export function useLiveValue(path: string): LiveReading {
  return useLiveValues([path])[path]!;
}

/** Route server events into the query cache and the alarm store. */
export function useEventBridge(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    socket.start();
    return socket.onEvent((ev) => {
      switch (ev.type) {
        case 'system.status':
          qc.setQueryData(['system'], ev.payload as SystemStatus);
          break;
        case 'alarm.raised':
        case 'alarm.acked':
          useAlarms.getState().upsert(ev.payload as ActiveAlarm);
          break;
        case 'alarm.cleared':
          useAlarms.getState().remove((ev.payload as { id: string }).id);
          break;
        case 'dashboard.updated':
          void qc.invalidateQueries({ queryKey: ['dashboards'] });
          break;
        default:
          break;
      }
    });
  }, [enabled, qc]);
}
