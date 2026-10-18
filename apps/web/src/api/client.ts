import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type { Me, PathInfo, SystemStatus, UserMapping } from '@watchkeeper/shared';
import { apiUrl } from './base';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; message?: string } | null,
  ) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    // Network failure: the add-on is unreachable.
    throw new ApiError(0, { error: 'offline', message: 'Data Hub unreachable' });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

const retryUnlessClientError = (count: number, err: unknown) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 3;

export const useSetupStatus = () =>
  useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/setup/status'), retry: retryUnlessClientError });

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: retryUnlessClientError, staleTime: 60_000 });

export const useUserMappings = (enabled = true) =>
  useQuery({ queryKey: ['users'], queryFn: () => api<UserMapping[]>('/users'), retry: retryUnlessClientError, enabled });

export const usePinUsers = () => useQuery({ queryKey: ['pin-users'], queryFn: () => api<{ id: string; name: string }[]>('/auth/pin-users') });

export const useSystemStatus = (opts: Partial<UseQueryOptions<SystemStatus>> = {}) =>
  useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemStatus>('/system/status'),
    refetchInterval: 15_000,
    retry: false,
    ...opts,
  });

/** The path list and values for paths the backend doesn't stream. Live values come over the WebSocket. */
export const usePaths = (intervalMs = 10_000) =>
  useQuery({ queryKey: ['paths'], queryFn: () => api<PathInfo[]>('/paths'), refetchInterval: intervalMs, retry: false });
