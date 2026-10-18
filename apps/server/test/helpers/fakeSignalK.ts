// A fake Signal K server: the stream WebSocket plus the REST snapshot, with
// replay of fixture deltas at 1x or accelerated speed.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Delta, FixtureLine } from './fixtures.js';

export class FakeSignalK {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly latest = new Map<string, { value: unknown; timestamp: string }>();
  /** Subscribe messages received from clients. */
  readonly subscriptions: unknown[] = [];
  port = 0;

  static async start(port = 0): Promise<FakeSignalK> {
    const f = new FakeSignalK();
    await f.listen(port);
    return f;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private async listen(port: number): Promise<void> {
    this.http = createServer((req, res) => {
      if (req.url?.startsWith('/signalk/v1/api/vessels/self')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(this.tree()));
        return;
      }
      res.statusCode = 404; // no security, so no access-request endpoint
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/signalk/v1/stream' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('message', (m) => this.subscriptions.push(JSON.parse(m.toString())));
      ws.send(
        JSON.stringify({
          name: 'fake-signalk',
          version: '2.0.0',
          self: 'vessels.urn:mrn:imo:mmsi:000000000',
          roles: ['master', 'main'],
          timestamp: new Date().toISOString(),
        }),
      );
    });
    await new Promise<void>((resolve) => this.http!.listen(port, '127.0.0.1', resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  send(delta: Delta): void {
    for (const u of delta.updates) {
      for (const v of u.values) this.latest.set(v.path, { value: v.value, timestamp: u.timestamp });
    }
    const msg = JSON.stringify(delta);
    for (const c of this.clients) c.send(msg);
  }

  /** Replay lines, keeping their relative timing divided by `speed`. */
  async replay(lines: Iterable<FixtureLine> | AsyncIterable<FixtureLine>, speed = 1): Promise<void> {
    let first: number | null = null;
    const startedAt = Date.now();
    for await (const line of lines) {
      first ??= line.t;
      const due = startedAt + (line.t - first) / speed;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.send(line.delta);
    }
  }

  /** Kill the server: drop every client and stop listening. */
  async stop(): Promise<void> {
    for (const c of this.clients) c.terminate();
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

  private tree(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const [path, leaf] of this.latest) {
      const parts = path.split('.');
      let node = root;
      for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
      node[parts[parts.length - 1]!] = { value: leaf.value, timestamp: leaf.timestamp };
    }
    return root;
  }
}
