// Signal K device access-request flow. On first run the backend asks Signal K
// for a token; the skipper approves it once in the Signal K admin UI. The
// token is stored in /data with 0600 permissions.

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Permission = 'readwrite' | 'readonly';

interface TokenSpec {
  name: string;
  permission: Permission;
  description: string;
}

/** The backend's token. Browsers never talk to Signal K, so this is the only one. */
export const DEVICE_TOKEN: TokenSpec = { name: 'signalk-token', permission: 'readwrite', description: 'Data Hub' };

function writeSecret(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readToken(configDir: string, spec: TokenSpec): string | null {
  const f = join(configDir, spec.name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || null : null;
}

export type AccessState = 'approved' | 'pending' | 'denied' | 'not-required' | 'error';

interface AccessRequestResponse {
  state?: string;
  href?: string;
  accessRequest?: { permission?: string; token?: string };
}

/**
 * Advance the access request for one token by a single step: submit it if
 * none is pending, otherwise poll it. Safe to call repeatedly.
 */
export async function stepAccessRequest(
  signalkUrl: string,
  configDir: string,
  spec: TokenSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessState> {
  mkdirSync(configDir, { recursive: true });
  if (readToken(configDir, spec)) return 'approved';

  const reqFile = join(configDir, `${spec.name}.request.json`);
  const pending = existsSync(reqFile) ? (JSON.parse(readFileSync(reqFile, 'utf8')) as { clientId: string; href?: string }) : null;
  const clientId = pending?.clientId ?? randomUUID();

  try {
    if (!pending?.href) {
      const res = await fetchImpl(`${signalkUrl}/signalk/v1/access/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, description: spec.description, permissions: spec.permission }),
      });
      // Signal K without security enabled has no access-request endpoint.
      if (res.status === 404 || res.status === 501) return 'not-required';
      const body = (await res.json()) as AccessRequestResponse;
      if (!body.href) return 'error';
      writeSecret(reqFile, JSON.stringify({ clientId, href: body.href }));
      return 'pending';
    }

    const res = await fetchImpl(`${signalkUrl}${pending.href}`);
    if (res.status === 404) {
      writeSecret(reqFile, JSON.stringify({ clientId }));
      return 'pending';
    }
    const body = (await res.json()) as AccessRequestResponse;
    if (body.state !== 'COMPLETED') return 'pending';
    if (body.accessRequest?.permission === 'APPROVED' && body.accessRequest.token) {
      writeSecret(join(configDir, spec.name), body.accessRequest.token);
      writeSecret(reqFile, JSON.stringify({ clientId, done: true }));
      return 'approved';
    }
    writeSecret(reqFile, JSON.stringify({ clientId }));
    return 'denied';
  } catch {
    return 'error';
  }
}
