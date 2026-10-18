// The backend talks to Home Assistant only through this interface, so it runs
// outside HA in dev and tests with the fake.

export interface HaClient {
  /** Read an HA entity's state, e.g. the system monitor's CPU temperature. */
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown> } | null>;
  /** Publish one of the add-on's summary entities. */
  setState(entityId: string, state: string, attributes?: Record<string, unknown>): Promise<void>;
  /** Companion app notification. `critical` breaks through Do Not Disturb on iOS. */
  notify(title: string, message: string, opts?: { critical?: boolean }): Promise<void>;
  /** Ask the Supervisor to shut the host down (UPS low voltage). */
  shutdownHost(): Promise<void>;
}

/** The real client, using the Supervisor token HA gives the add-on. */
export class SupervisorHaClient implements HaClient {
  constructor(
    private readonly token: string,
    private readonly base = 'http://supervisor',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private req(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  async getState(entityId: string) {
    const res = await this.req(`/core/api/states/${encodeURIComponent(entityId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { state: string; attributes: Record<string, unknown> };
    return { state: body.state, attributes: body.attributes };
  }

  async setState(entityId: string, state: string, attributes: Record<string, unknown> = {}) {
    await this.req(`/core/api/states/${encodeURIComponent(entityId)}`, { method: 'POST', body: JSON.stringify({ state, attributes }) });
  }

  async notify(title: string, message: string, opts: { critical?: boolean } = {}) {
    const data = opts.critical ? { push: { sound: { name: 'default', critical: 1, volume: 1.0 } }, ttl: 0, priority: 'high' } : {};
    await this.req('/core/api/services/notify/notify', { method: 'POST', body: JSON.stringify({ title, message, data }) });
  }

  async shutdownHost() {
    await this.req('/host/shutdown', { method: 'POST' });
  }
}

/** Records every call. Used in dev (outside HA) and in tests. */
export class FakeHaClient implements HaClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly states = new Map<string, { state: string; attributes: Record<string, unknown> }>();

  async getState(entityId: string) {
    this.calls.push({ method: 'getState', args: [entityId] });
    return this.states.get(entityId) ?? null;
  }

  async setState(entityId: string, state: string, attributes: Record<string, unknown> = {}) {
    this.calls.push({ method: 'setState', args: [entityId, state, attributes] });
    this.states.set(entityId, { state, attributes });
  }

  async notify(title: string, message: string, opts: { critical?: boolean } = {}) {
    this.calls.push({ method: 'notify', args: [title, message, opts] });
  }

  async shutdownHost() {
    this.calls.push({ method: 'shutdownHost', args: [] });
  }
}
