import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ServerEvent, SystemStatus } from '@watchkeeper/shared';
import { useAlarms, type ActiveAlarm } from '../shell/alarms';

/** Keep one socket to /api/v1/events open and fan its events out to the app. */
export function useEventSocket(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/v1/events`);
      ws.onmessage = (e) => {
        let ev: ServerEvent;
        try {
          ev = JSON.parse(String(e.data)) as ServerEvent;
        } catch {
          return;
        }
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
      };
      ws.onclose = () => {
        if (!closed) timer = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [enabled, qc]);
}
