import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RATE_PERIOD_MS, type RateClass } from '@watchkeeper/shared';
import { iso, type Clock } from '../clock.js';
import { buildDelta, type OutboundValue } from './outbound.js';
import type { LiveStore } from './store.js';

export interface Subscription {
  path: string;
  periodMs: number;
}

/** Subscriptions for catalog paths at their rate-class periods. */
export function subscriptionsFor(paths: string[], describe: (p: string) => { rateClass: RateClass }): Subscription[] {
  return paths.map((path) => ({ path, periodMs: RATE_PERIOD_MS[describe(path).rateClass] }));
}

export interface GapRecorder {
  open(atMs: number): void;
  close(atMs: number): void;
}

export interface SignalKClientOptions {
  url: string;
  store: LiveStore;
  clock: Clock;
  gaps: GapRecorder;
  token?: () => string | null;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
}

interface SignalKDelta {
  /** Present on the hello message: our own vessel's context. */
  self?: string;
  context?: string;
  updates?: { timestamp?: string; values?: { path: string; value: unknown }[] }[];
}

/**
 * The backend's one long-lived Signal K stream. Subscribes to every path the
 * app records or alarms on, reconnects with exponential backoff, and marks
 * everything stale while disconnected.
 */
export class SignalKClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs: Subscription[] = [];
  private backoff: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private gapOpen = false;
  connected = false;
  connectedSince: number | null = null;
  log: SignalKClientOptions['log'];
  /** Whether the current connection authenticated with a token. */
  usingToken = false;
  private selfContext: string | null = null;

  constructor(private readonly opts: SignalKClientOptions) {
    super();
    this.backoff = opts.initialBackoffMs ?? 1000;
    this.log = opts.log;
  }

  get streamUrl(): string {
    return this.opts.url.replace(/^http/, 'ws') + '/signalk/v1/stream?subscribe=none';
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      // Terminating a socket that is still connecting emits 'error'; with no listener that would throw.
      this.ws.on('error', () => {});
      this.ws.terminate();
    }
    this.ws = null;
    this.connected = false;
  }

  /** Drop the current connection so it reconnects, e.g. after a new token. */
  reconnect(): void {
    this.ws?.terminate();
  }

  /** Each path at its rate-class period. Browsers never change these rates. */
  setSubscriptions(subs: Subscription[]): void {
    this.subs = [...new Map(subs.map((s) => [s.path, s])).values()];
    if (this.connected) this.sendSubscribe();
  }

  /** Write values to Signal K. Throws on any path outside the allowlist. */
  send(values: OutboundValue[]): void {
    const delta = buildDelta(values, iso(this.opts.clock.now()));
    if (this.ws && this.connected) this.ws.send(JSON.stringify(delta));
  }

  private connect(): void {
    if (this.stopped) return;
    const token = this.opts.token?.() ?? null;
    this.usingToken = token !== null;
    const ws = new WebSocket(this.streamUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    this.ws = ws;
    ws.on('open', () => this.onOpen());
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => this.onDown());
    ws.on('error', (err) => {
      this.log?.warn(`Signal K stream error: ${err.message}`);
    });
  }

  private onOpen(): void {
    const now = this.opts.clock.now();
    this.connected = true;
    this.connectedSince = now;
    this.backoff = this.opts.initialBackoffMs ?? 1000;
    if (this.gapOpen) {
      this.opts.gaps.close(now);
      this.gapOpen = false;
    }
    this.log?.info(`Signal K connected: ${this.opts.url}`);
    this.sendSubscribe();
    this.emit('status', true);
  }

  private onMessage(text: string): void {
    let msg: SignalKDelta;
    try {
      msg = JSON.parse(text) as SignalKDelta;
    } catch {
      return;
    }
    // The hello message names our own vessel. Deltas for any other context
    // (AIS targets, other vessels) must never land in our store.
    if (typeof msg.self === 'string') this.selfContext = msg.self;
    if (!msg.updates) return;
    if (msg.context && msg.context !== 'vessels.self' && msg.context !== this.selfContext) return;
    const now = this.opts.clock.now();
    for (const u of msg.updates) {
      for (const v of u.values ?? []) {
        if (typeof v.path === 'string' && v.path !== '') this.opts.store.update(v.path, v.value, now);
      }
    }
  }

  private onDown(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.connectedSince = null;
    this.ws?.removeAllListeners();
    this.ws = null;
    if (!this.gapOpen) {
      this.opts.gaps.open(this.opts.clock.now());
      this.gapOpen = true;
    }
    this.opts.store.markAllStale();
    if (wasConnected) {
      this.log?.warn('Signal K connection lost');
      this.emit('status', false);
    }
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private sendSubscribe(): void {
    if (!this.ws || this.subs.length === 0) return;
    this.ws.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: this.subs.map((s) => ({ path: s.path, period: s.periodMs, policy: 'instant' })),
      }),
    );
  }
}
