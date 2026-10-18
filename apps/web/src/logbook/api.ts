import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { AmendInput, LogEntry, ManualEntryInput, Passage, PassageInput, PassageSuggestion, PassageSummary } from '@watchkeeper/shared';
import { api, ApiError } from '../api/client';
import { apiUrl } from '../api/base';

// Query keys start with 'log' or 'passages', so log.* and passage.* events
// from the backend refresh everything that might show them.

export type LogFilter = 'all' | 'hourly' | 'events' | 'unsigned';

export const useActivePassage = (enabled = true) =>
  useQuery({
    queryKey: ['passages', 'active'],
    queryFn: () => api<{ passage: Passage | null; summary: PassageSummary | null }>('/passages/active'),
    refetchInterval: 60_000,
    enabled,
  });

export const usePassages = () => useQuery({ queryKey: ['passages', 'list'], queryFn: () => api<Passage[]>('/passages') });

export const usePassageSummary = (id: string | undefined) =>
  useQuery({ queryKey: ['passages', 'summary', id], queryFn: () => api<PassageSummary>(`/passages/${id}/summary`), enabled: !!id, retry: false });

export const useSuggestion = (enabled: boolean) =>
  useQuery({
    queryKey: ['passages', 'suggestion'],
    queryFn: () => api<{ suggestion: PassageSuggestion | null }>('/passages/suggestion'),
    enabled,
    refetchInterval: 5 * 60_000,
  });

/** `passageId` null lists every entry; undefined waits (the passage isn't known yet). */
export function useLog(passageId: string | null | undefined, filter: LogFilter, limit = 200) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (passageId) q.set('passageId', passageId);
  if (filter === 'hourly') q.set('kind', 'hourly');
  if (filter === 'events') q.set('kind', 'events');
  if (filter === 'unsigned') q.set('unsigned', 'true');
  return useQuery({
    queryKey: ['log', 'list', passageId ?? 'all', filter, limit],
    queryFn: () => api<LogEntry[]>(`/log?${q}`),
    enabled: passageId !== undefined,
  });
}

export const useEntry = (id: string | undefined) =>
  useQuery({ queryKey: ['log', 'entry', id], queryFn: () => api<LogEntry>(`/log/${id}`), enabled: !!id, retry: false });

export const attachmentUrl = (id: string) => apiUrl(`/attachments/${id}`);
export const exportUrl = (passageId: string, ext: 'pdf' | 'csv' | 'gpx') => apiUrl(`/passages/${passageId}/export.${ext}`);

async function upload(entryId: string, file: Blob): Promise<void> {
  const body = new FormData();
  body.set('ownerType', 'log_entry');
  body.set('ownerId', entryId);
  body.set('file', file, 'photo.jpg');
  let res: Response;
  try {
    res = await fetch(apiUrl('/attachments'), { method: 'POST', body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'offline', message: 'Data Hub unreachable' });
  }
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null)) as { message?: string } | null);
}

export function useLogMutations() {
  const qc = useQueryClient();
  return useMemo(() => {
    const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['log'] }), qc.invalidateQueries({ queryKey: ['passages'] })]);
    const putEntry = (e: LogEntry) => {
      qc.setQueryData(['log', 'entry', e.id], e);
      void refresh();
      return e;
    };
    const thenRefresh = async <T,>(p: Promise<T>): Promise<T> => {
      const v = await p;
      await refresh();
      return v;
    };
    return {
      startPassage: (input: PassageInput) => thenRefresh(api<Passage>('/passages', { method: 'POST', body: input })),
      updatePassage: (id: string, input: PassageInput) => thenRefresh(api<Passage>(`/passages/${id}`, { method: 'PUT', body: input })),
      endPassage: (id: string) => thenRefresh(api<Passage>(`/passages/${id}/end`, { method: 'POST' })),
      dismissSuggestion: () =>
        api('/passages/suggestion', { method: 'DELETE' }).then(() => qc.setQueryData(['passages', 'suggestion'], { suggestion: null })),
      /** The entry is saved first; a photo that fails to upload doesn't lose it. */
      create: async (input: ManualEntryInput, photo: Blob | null): Promise<{ entry: LogEntry; photoError: string | null }> => {
        const entry = await api<LogEntry>('/log', { method: 'POST', body: input });
        let photoError: string | null = null;
        if (photo) await upload(entry.id, photo).catch((e: Error) => (photoError = e.message));
        void refresh();
        return { entry, photoError };
      },
      sign: (id: string) => api<LogEntry>(`/log/${id}/sign`, { method: 'POST' }).then(putEntry),
      amend: (id: string, a: AmendInput) => api<LogEntry>(`/log/${id}/amend`, { method: 'POST', body: a }).then(putEntry),
      addPhoto: (id: string, photo: Blob) => thenRefresh(upload(id, photo)),
    };
  }, [qc]);
}

/** Shrink a photo to 2048 px on the long edge as JPEG before upload: boat Wi-Fi and SD cards are small. */
export async function resizePhoto(file: File, maxEdge = 2048): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', 0.85));
}
