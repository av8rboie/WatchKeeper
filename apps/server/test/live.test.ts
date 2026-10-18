import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import type { LiveMessage } from '@watchkeeper/shared';
import { EventHub } from '../src/api/events.js';
import { ManualClock } from '../src/clock.js';
import { LiveStore } from '../src/signalk/store.js';
import { T0 } from './helpers/fixtures.js';

/** Just enough of a ws WebSocket for the hub. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  subscribe(paths: string[]) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'live.subscribe', paths })));
  }
  get live(): LiveMessage[] {
    return this.sent.filter((m): m is LiveMessage => (m as { type: string }).type === 'live');
  }
}

describe('live values over the Data Hub WebSocket', () => {
  it('sends only subscribed paths, batched to one message per flush (4 Hz cap)', () => {
    const clock = new ManualClock(T0);
    const store = new LiveStore(clock);
    const hub = new EventHub(store, () => clock.now());
    const a = new FakeSocket();
    hub.add(a as unknown as WebSocket); // the fake implements the parts the hub uses
    a.subscribe(['navigation.speedOverGround']);

    // 20 updates between two flushes: the client gets one batch with the latest value.
    for (let i = 0; i < 20; i++) {
      clock.advance(10);
      store.update('navigation.speedOverGround', i);
      store.update('environment.depth.belowKeel', i);
    }
    hub.flushLive();
    expect(a.live).toHaveLength(1);
    expect(a.live[0]!.values).toEqual({ 'navigation.speedOverGround': [19, clock.now()] });
    expect(a.live[0]!.now).toBe(clock.now());

    // Nothing changed: no message.
    hub.flushLive();
    expect(a.live).toHaveLength(1);
    hub.closeAll();
  });

  it('a new subscription gets current values on the next batch and replaces the old one', () => {
    const clock = new ManualClock(T0);
    const store = new LiveStore(clock);
    const hub = new EventHub(store, () => clock.now());
    store.update('environment.depth.belowKeel', 12.5);
    const a = new FakeSocket();
    hub.add(a as unknown as WebSocket);
    a.subscribe(['environment.depth.belowKeel', 'navigation.position']);
    hub.flushLive();
    expect(Object.keys(a.live[0]!.values)).toEqual(['environment.depth.belowKeel']);

    a.subscribe(['navigation.position']);
    store.update('environment.depth.belowKeel', 13);
    hub.flushLive();
    expect(a.live).toHaveLength(1);
    hub.closeAll();
  });

  it('ignores malformed client messages', () => {
    const store = new LiveStore(new ManualClock(T0));
    const hub = new EventHub(store);
    const a = new FakeSocket();
    hub.add(a as unknown as WebSocket);
    a.emit('message', Buffer.from('not json'));
    a.emit('message', Buffer.from(JSON.stringify({ type: 'live.subscribe', paths: 'nope' })));
    store.update('navigation.speedOverGround', 1);
    hub.flushLive();
    expect(a.live).toHaveLength(0);
    hub.closeAll();
  });
});
