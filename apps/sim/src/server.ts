// A synthetic Signal K server built on BoatModel. It speaks enough of the
// protocol for Data Hub: discovery, the v1 stream with subscribe messages and
// periods, the REST tree, and device access requests. Like Signal K 2.33 with
// security on, an unauthenticated stream gets the hello and nothing else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { BoatModel, type ModelOptions, type Override, type PhaseSpec } from './model.js';

export interface SimServerOptions {
  port?: number;
  host?: string;
  model?: BoatModel | ModelOptions;
  /** Simulated seconds per real second. */
  speed?: number;
  /** Require a device token on the stream and REST API (Signal K's default). */
  requireAuth?: boolean;
  /** Approve access requests as soon as they arrive. */
  autoApprove?: boolean;
  /** How often the stream is serviced, real ms. */
  tickMs?: number;
}

interface Sub {
  re: RegExp;
  periodMs: number;
}

interface Client {
  ws: WebSocket;
  authorized: boolean;
  subs: Sub[];
  lastSent: Map<string, number>;
}

interface AccessRequest {
  clientId: string;
  description: string;
  permission: string;
  approved: boolean;
}

/** Tokens survive a simulator restart, as a real server's do. */
const TOKEN_PREFIX = 'sim-token-';

const SELF = 'vessels.urn:mrn:imo:mmsi:999000001';

function pathPattern(p: string): RegExp {
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export class SimServer {
  readonly model: BoatModel;
  speed: number;
  requireAuth: boolean;
  autoApprove: boolean;
  port = 0;
  private readonly host: string;
  private readonly tickMs: number;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly clients = new Set<Client>();
  private readonly requests = new Map<string, AccessRequest>();
  /** Values written by clients (Data Hub's derived values and notifications). */
  readonly written = new Map<string, { value: unknown; timestamp: string }>();
  /** Every delta a client sent, for tests. */
  readonly received: unknown[] = [];
  /** Every subscribe message, for tests. */
  readonly subscribeMessages: unknown[] = [];
  /** Called after each delta goes out, with the real time it was sent (latency tests). */
  onSent: ((values: { path: string; value: unknown }[], atMs: number) => void) | null = null;
  private simAnchor: number;
  private realAnchor: number;

  private constructor(opts: SimServerOptions) {
    this.model = opts.model instanceof BoatModel ? opts.model : new BoatModel(opts.model);
    this.speed = opts.speed ?? 1;
    this.requireAuth = opts.requireAuth ?? true;
    this.autoApprove = opts.autoApprove ?? true;
    this.host = opts.host ?? '127.0.0.1';
    this.tickMs = opts.tickMs ?? 200;
    this.simAnchor = this.model.t;
    this.realAnchor = Date.now();
  }

  static async start(opts: SimServerOptions = {}): Promise<SimServer> {
    const s = new SimServer(opts);
    await s.listen(opts.port ?? 0);
    return s;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Simulated time now. */
  simNow(): number {
    return this.simAnchor + (Date.now() - this.realAnchor) * this.speed;
  }

  setSpeed(speed: number): void {
    this.simAnchor = this.simNow();
    this.realAnchor = Date.now();
    this.speed = speed;
  }

  private async listen(port: number): Promise<void> {
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://sim');
      if (url.pathname !== '/signalk/v1/stream') {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onStream(ws, req, url));
    });
    await new Promise<void>((resolve) => this.http!.listen(port, this.host, resolve));
    this.port = (this.http.address() as AddressInfo).port;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Kill the server: drop every client and stop listening. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.wss = null;
    this.http = null;
  }

  /** Bring the server back on the same port. */
  async restart(): Promise<void> {
    await this.listen(this.port);
  }

  /** Drop every stream client without stopping the server. */
  dropClients(): void {
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
  }

  private tokenFrom(req: IncomingMessage, url: URL): string | null {
    const h = req.headers.authorization;
    const m = h ? /^(?:Bearer|JWT)\s+(.+)$/i.exec(h) : null;
    return m?.[1] ?? url.searchParams.get('token');
  }

  private isAuthorized(token: string | null): boolean {
    return !this.requireAuth || (token !== null && token.startsWith(TOKEN_PREFIX));
  }

  private onStream(ws: WebSocket, req: IncomingMessage, url: URL): void {
    const client: Client = { ws, authorized: this.isAuthorized(this.tokenFrom(req, url)), subs: [], lastSent: new Map() };
    const initial = url.searchParams.get('subscribe') ?? 'self';
    if (initial === 'self' || initial === 'all') client.subs.push({ re: /.*/, periodMs: 1000 });
    this.clients.add(client);
    ws.send(JSON.stringify({ name: 'watchkeeper-sim', version: '2.33.0', self: SELF, roles: ['master', 'main'], timestamp: new Date(this.model.t).toISOString() }));
    ws.on('message', (data) => this.onClientMessage(client, data.toString()));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  private onClientMessage(client: Client, text: string): void {
    let msg: {
      subscribe?: { path: string; period?: number }[];
      unsubscribe?: { path: string }[];
      updates?: { timestamp?: string; values?: { path: string; value: unknown }[] }[];
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.subscribe) {
      this.subscribeMessages.push(msg);
      for (const s of msg.subscribe) client.subs.push({ re: pathPattern(s.path), periodMs: s.period ?? 1000 });
    }
    if (msg.unsubscribe) {
      const gone = msg.unsubscribe.map((u) => pathPattern(u.path).source);
      client.subs = msg.unsubscribe.some((u) => u.path === '*') ? [] : client.subs.filter((s) => !gone.includes(s.re.source));
    }
    if (msg.updates && client.authorized) {
      this.received.push(msg);
      for (const u of msg.updates) {
        for (const v of u.values ?? []) this.written.set(v.path, { value: v.value, timestamp: u.timestamp ?? new Date(this.model.t).toISOString() });
      }
    }
  }

  /** Advance the model to simulated now and send each client what is due. */
  tick(): void {
    this.model.advanceTo(this.simNow());
    if (this.clients.size === 0) return;
    const values = this.model.values();
    const now = Date.now();
    const timestamp = new Date(this.model.t).toISOString();
    for (const c of this.clients) {
      if (!c.authorized || c.subs.length === 0 || c.ws.readyState !== c.ws.OPEN) continue;
      const due: { path: string; value: unknown }[] = [];
      for (const [path, value] of Object.entries(values)) {
        let period = Infinity;
        for (const s of c.subs) if (s.periodMs < period && s.re.test(path)) period = s.periodMs;
        if (period === Infinity) continue;
        const last = c.lastSent.get(path);
        if (last !== undefined && now - last < period) continue;
        c.lastSent.set(path, now);
        due.push({ path, value });
      }
      if (due.length > 0) {
        c.ws.send(JSON.stringify({ context: SELF, updates: [{ $source: 'sim', timestamp, values: due }] }));
        this.onSent?.(due, Date.now());
      }
    }
  }

  /** vessels/self as a Signal K tree of {value, timestamp} leaves. */
  tree(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const timestamp = new Date(this.model.t).toISOString();
    const leaves: [string, { value: unknown; timestamp: string }][] = [
      ...Object.entries(this.model.values()).map(([p, value]): [string, { value: unknown; timestamp: string }] => [p, { value, timestamp }]),
      ...this.written,
    ];
    for (const [path, leaf] of leaves) {
      const parts = path.split('.');
      let node = root;
      for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
      node[parts[parts.length - 1]!] = { ...leaf, $source: 'sim' };
    }
    return root;
  }

  /** Change the simulation: scenario, speed, or path overrides (DEAD stops a path). */
  control(body: { scenario?: string | PhaseSpec[]; speed?: number; overrides?: Record<string, Override>; clear?: boolean | string[]; requireAuth?: boolean }): void {
    if (body.scenario !== undefined) this.model.setScenario(body.scenario);
    if (typeof body.speed === 'number' && body.speed > 0) this.setSpeed(body.speed);
    if (body.clear === true) this.model.overrides.clear();
    else if (Array.isArray(body.clear)) for (const p of body.clear) this.model.overrides.delete(p);
    for (const [path, v] of Object.entries(body.overrides ?? {})) this.model.overrides.set(path, v);
    if (typeof body.requireAuth === 'boolean') this.requireAuth = body.requireAuth;
  }

  state() {
    return {
      t: new Date(this.model.t).toISOString(),
      phase: this.model.phase.phase,
      speed: this.speed,
      clients: this.clients.size,
      requireAuth: this.requireAuth,
      overrides: Object.fromEntries(this.model.overrides),
      pendingRequests: [...this.requests.entries()].filter(([, r]) => !r.approved).map(([id, r]) => ({ id, ...r })),
    };
  }

  approveAll(): void {
    for (const r of this.requests.values()) r.approved = true;
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname.replace(/\/$/, '');
    try {
      if (req.method === 'GET' && path === '/signalk') {
        const host = req.headers.host;
        return send(res, 200, {
          endpoints: { v1: { version: '2.33.0', 'signalk-http': `http://${host}/signalk/v1/api/`, 'signalk-ws': `ws://${host}/signalk/v1/stream` } },
          server: { id: 'watchkeeper-sim', version: '2.33.0' },
        });
      }
      if (req.method === 'GET' && path.startsWith('/signalk/v1/api/vessels/self')) {
        if (!this.isAuthorized(this.tokenFrom(req, url))) return send(res, 401, { message: 'Unauthorized' });
        let node: unknown = this.tree();
        for (const p of path.slice('/signalk/v1/api/vessels/self'.length).split('/').filter(Boolean)) node = (node as Record<string, unknown> | undefined)?.[p];
        return node === undefined ? send(res, 404, { message: 'Not found' }) : send(res, 200, node);
      }
      if (req.method === 'POST' && path === '/signalk/v1/access/requests') {
        const body = (await readJson(req)) as { clientId?: string; description?: string; permissions?: string };
        const id = `req-${this.requests.size + 1}`;
        this.requests.set(id, { clientId: body.clientId ?? id, description: body.description ?? '', permission: body.permissions ?? 'readonly', approved: this.autoApprove });
        return send(res, 202, { state: 'PENDING', requestId: id, href: `/signalk/v1/requests/${id}` });
      }
      const m = /^\/signalk\/v1\/requests\/(.+)$/.exec(path);
      if (req.method === 'GET' && m) {
        const r = this.requests.get(m[1]!);
        if (!r) return send(res, 404, { message: 'No such request' });
        if (!r.approved) return send(res, 200, { state: 'PENDING', requestId: m[1] });
        return send(res, 200, {
          state: 'COMPLETED',
          requestId: m[1],
          statusCode: 200,
          accessRequest: { permission: 'APPROVED', token: `${TOKEN_PREFIX}${r.clientId}`, expirationTime: null },
        });
      }
      // Simulator controls (not part of Signal K).
      if (req.method === 'GET' && path === '/sim/state') return send(res, 200, this.state());
      if (req.method === 'POST' && path === '/sim/control') {
        this.control((await readJson(req)) as Parameters<SimServer['control']>[0]);
        return send(res, 200, this.state());
      }
      if (req.method === 'POST' && path === '/sim/approve') {
        this.approveAll();
        return send(res, 200, this.state());
      }
      if (req.method === 'POST' && path === '/sim/drop') {
        this.dropClients();
        return send(res, 200, this.state());
      }
      return send(res, 404, { message: 'Not found' });
    } catch (e) {
      return send(res, 400, { message: (e as Error).message });
    }
  }
}
