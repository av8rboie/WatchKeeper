import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type { Me, PathInfo, SystemStatus, UserPublic } from '@watchkeeper/shared';

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
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    // Network failure: the backend is unreachable.
    throw new ApiError(0, { error: 'offline', message: 'Data Hub offline' });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

const noRetryOnAuth = (count: number, err: unknown) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

export const useSetupStatus = () =>
  useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/setup/status'), retry: noRetryOnAuth });

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: noRetryOnAuth, staleTime: 60_000 });

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api<UserPublic[]>('/users'), retry: noRetryOnAuth });

export const useSystemStatus = (opts: Partial<UseQueryOptions<SystemStatus>> = {}) =>
  useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemStatus>('/system/status'),
    refetchInterval: 5000,
    retry: false,
    ...opts,
  });

export const usePaths = (intervalMs = 2000) =>
  useQuery({ queryKey: ['paths'], queryFn: () => api<PathInfo[]>('/paths'), refetchInterval: intervalMs, retry: false });
