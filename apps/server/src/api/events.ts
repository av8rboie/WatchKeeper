import type { WebSocket } from 'ws';
import type { EventType, ServerEvent } from '@watchkeeper/shared';

/** Pushes changes to every open client over /api/v1/events. */
export class EventHub {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  broadcast<T>(type: EventType, payload: T): void {
    const msg = JSON.stringify({ type, payload } satisfies ServerEvent<T>);
    for (const s of this.sockets) {
      if (s.readyState === s.OPEN) s.send(msg);
    }
  }

  get size(): number {
    return this.sockets.size;
  }

  closeAll(): void {
    for (const s of this.sockets) s.close();
    this.sockets.clear();
  }
}
