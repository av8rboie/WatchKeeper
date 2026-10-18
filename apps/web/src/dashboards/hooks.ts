import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { breakpointFor, type Breakpoint } from '@watchkeeper/shared';

/** The breakpoint for the viewport width: phone under 600 px, tablet to 1023 px, desktop above. */
export function useViewportBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => breakpointFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setBp(breakpointFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return bp;
}

const KEEP_SCREEN_ON = 'dh.keepScreenOn';

function readKeepOn(): boolean {
  try {
    return localStorage.getItem(KEEP_SCREEN_ON) === '1';
  } catch {
    return false;
  }
}

/** "Keep screen on" is per device, like the theme: the helm phone wants it, the laptop may not. */
export const useKeepScreenOn = create<{ on: boolean; set(on: boolean): void }>((set) => ({
  on: readKeepOn(),
  set: (on) => {
    try {
      localStorage.setItem(KEEP_SCREEN_ON, on ? '1' : '0');
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
    set({ on });
  },
}));

/** Hold a Screen Wake Lock while mounted and enabled; re-acquire it when the page becomes visible again. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible' && !cancelled) lock = await navigator.wakeLock.request('screen');
      } catch {
        // Denied (battery saver, or not allowed in this frame): the screen may sleep.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}
