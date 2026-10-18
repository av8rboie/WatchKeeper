import type { WebSocket } from 'ws';
import { LIVE_MAX_HZ, LiveSubscribeSchema, type EventType, type LiveMessage, type ServerEvent } from '@watchkeeper/shared';
import type { LiveStore } from '../signalk/store.js';

interface Client {
  socket: WebSocket;
  paths: Set<string>;
  dirty: Set<string>;
}

/**
 * The one WebSocket browsers use: live instrument values for the paths each
 * client asked for, batched to at most LIVE_MAX_HZ per client, plus change
 * events. Browsers never connect to Signal K.
 */
export class EventHub {
  private readonly clients = new Set<Client>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly store: LiveStore,
    private readonly now: () => number = Date.now,
  ) {
    store.on('update', (path: string) => {
      for (const c of this.clients) if (c.paths.has(path)) c.dirty.add(path);
    });
    this.timer = setInterval(() => this.flushLive(), 1000 / LIVE_MAX_HZ);
    this.timer.unref();
  }

  add(socket: WebSocket): void {
    const client: Client = { socket, paths: new Set(), dirty: new Set() };
    this.clients.add(client);
    socket.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const sub = LiveSubscribeSchema.safeParse(msg);
      if (!sub.success) return;
      client.paths = new Set(sub.data.paths);
      // Send what we already have on the next batch.
      client.dirty = new Set(sub.data.paths.filter((p) => this.store.read(p).updatedAt !== null));
    });
    const drop = () => this.clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  /** Send each client the values that changed since its last batch. */
  flushLive(): void {
    const now = this.now();
    for (const c of this.clients) {
      if (c.dirty.size === 0 || c.socket.readyState !== c.socket.OPEN) continue;
      const values: LiveMessage['values'] = {};
      for (const path of c.dirty) {
        const r = this.store.read(path, now);
        if (r.updatedAt !== null) values[path] = [r.value, r.updatedAt];
      }
      c.dirty.clear();
      c.socket.send(JSON.stringify({ type: 'live', now, values } satisfies LiveMessage));
    }
  }

  broadcast<T>(type: EventType, payload: T): void {
    const msg = JSON.stringify({ type, payload } satisfies ServerEvent<T>);
    for (const c of this.clients) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(msg);
    }
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.socket.close();
    this.clients.clear();
  }
}
