import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  Dashboard,
  DashboardInput,
  DashboardSummary,
  DerivedSettings,
  HistorySeries,
  Layouts,
  Threshold,
  ThresholdInput,
} from '@watchkeeper/shared';
import { api } from '../api/client';

// Every dashboard query key starts with 'dashboards', so a dashboard.updated
// event from another client refreshes them all.

export const useDashboards = () => useQuery({ queryKey: ['dashboards'], queryFn: () => api<DashboardSummary[]>('/dashboards') });

export const useDashboard = (id: string | undefined) =>
  useQuery({ queryKey: ['dashboards', id], queryFn: () => api<Dashboard>(`/dashboards/${id}`), enabled: !!id, retry: false });

export const useThresholds = () => useQuery({ queryKey: ['thresholds'], queryFn: () => api<Threshold[]>('/thresholds'), staleTime: 30_000 });

export const useDerivedSettings = () => useQuery({ queryKey: ['settings', 'derived'], queryFn: () => api<DerivedSettings>('/settings/derived') });

/** History for a trend: refetched every minute; live values are appended in between. */
export const useHistory = (paths: string[], windowMin: number, maxPoints = 400) =>
  useQuery({
    queryKey: ['history', paths.join(','), windowMin, maxPoints],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - windowMin * 60_000);
      const q = new URLSearchParams({ paths: paths.join(','), from: from.toISOString(), to: to.toISOString(), maxPoints: String(maxPoints) });
      return api<HistorySeries[]>(`/history?${q}`);
    },
    enabled: paths.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

/** Writes, each updating the cache with what the server returned. */
export function useDashboardMutations() {
  const qc = useQueryClient();
  return useMemo(() => {
    const put = (d: Dashboard) => {
      qc.setQueryData(['dashboards', d.id], d);
      void qc.invalidateQueries({ queryKey: ['dashboards'], exact: true });
      return d;
    };
    return {
      create: (input: DashboardInput) => api<Dashboard>('/dashboards', { method: 'POST', body: input }).then(put),
      replace: (id: string, input: DashboardInput) => api<Dashboard>(`/dashboards/${id}`, { method: 'PUT', body: input }).then(put),
      setLayouts: (id: string, layouts: Partial<Layouts>) => api<Dashboard>(`/dashboards/${id}/layouts`, { method: 'PUT', body: { layouts } }).then(put),
      remove: async (id: string) => {
        await api(`/dashboards/${id}`, { method: 'DELETE' });
        qc.removeQueries({ queryKey: ['dashboards', id] });
        await qc.invalidateQueries({ queryKey: ['dashboards'], exact: true });
      },
      starter: async () => {
        const list = await api<DashboardSummary[]>('/dashboards/starter', { method: 'POST' });
        qc.setQueryData(['dashboards'], list);
        return list;
      },
    };
  }, [qc]);
}

export function useThresholdMutations() {
  const qc = useQueryClient();
  return useMemo(() => {
    const done = <T,>(x: T) => {
      void qc.invalidateQueries({ queryKey: ['thresholds'] });
      return x;
    };
    return {
      create: (t: ThresholdInput) => api<Threshold>('/thresholds', { method: 'POST', body: t }).then(done),
      update: (id: string, t: ThresholdInput) => api<Threshold>(`/thresholds/${id}`, { method: 'PUT', body: t }).then(done),
      remove: (id: string) => api(`/thresholds/${id}`, { method: 'DELETE' }).then(done),
    };
  }, [qc]);
}
