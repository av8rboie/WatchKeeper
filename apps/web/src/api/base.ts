// Everything is built from the document base, which the backend sets from
// HA's ingress path. No absolute paths anywhere.

/** Router basename: the ingress path without its trailing slash. */
export function routerBasename(): string {
  return new URL(document.baseURI).pathname.replace(/\/$/, '');
}

export function apiUrl(path: string): string {
  return new URL(`api/v1${path}`, document.baseURI).toString();
}

export function wsUrl(path: string): string {
  const u = new URL(`api/v1${path}`, document.baseURI);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
