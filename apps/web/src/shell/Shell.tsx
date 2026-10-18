import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { roleAtLeast } from '@watchkeeper/shared';
import { api, useMe, useSystemStatus } from '../api/client';
import { useLive, useLiveValue, useNow } from '../live/socket';
import { useTheme } from '../theme/theme';
import { topAlarm, useAlarms, type ActiveAlarm } from './alarms';
import { IconButton } from './components';
import {
  AnchorIcon,
  ChecklistIcon,
  DashboardsIcon,
  LogIcon,
  MaintenanceIcon,
  MoonIcon,
  MoreIcon,
  SettingsIcon,
  SunIcon,
} from './icons';

/**
 * Status strip contents: Data Hub connection, Signal K, GPS fix, time with its
 * source (GPS or host), passage state.
 */
function useStatusSummary() {
  const q = useSystemStatus();
  const s = q.data;
  const connection = useLive((st) => st.connection);
  const position = useLiveValue('navigation.position');
  const now = useNow(1000);
  // Best time: the server's (GPS when fresh), advanced by local time since we heard it.
  const best = s ? new Date(Date.parse(s.time.now) + (now - q.dataUpdatedAt)) : new Date(now);
  const utc = `${String(best.getUTCHours()).padStart(2, '0')}:${String(best.getUTCMinutes()).padStart(2, '0')} UTC`;
  return {
    dataHub: connection === 'open',
    reconnecting: connection === 'reconnecting',
    signalk: s ? s.signalk.connected : null,
    gps: !position.stale,
    utc,
    timeSource: s ? (s.time.source === 'gps' ? 'GPS' : 'host clock') : null,
    passage: s?.passage.active ? `On passage · ${s.passage.name ?? ''}` : 'Not on passage',
  };
}

function NightToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <IconButton aria-label={theme === 'night' ? 'Switch to day mode' : 'Switch to night mode'} onClick={toggle} className={className}>
      {theme === 'night' ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}

/** Phone and tablet-portrait status strip, with the night toggle. */
function StatusStrip() {
  const s = useStatusSummary();
  const navigate = useNavigate();
  return (
    <div className="status-strip">
      <button type="button" className="status-strip__items" onClick={() => navigate('/settings#system')} aria-label="System status. Open settings.">
        <span className="status-strip__item">
          <span className={`dot ${s.dataHub ? '' : 'dot--off'}`} />
          {s.dataHub ? 'Data Hub' : 'Data Hub lost'}
        </span>
        <span className="status-strip__item">
          <span className={`dot ${s.signalk ? '' : 'dot--off'}`} />
          {s.signalk === false ? 'Signal K lost' : 'Signal K'}
        </span>
        <span className="status-strip__item">
          <span className={`dot ${s.gps ? '' : 'dot--off'}`} />
          {s.gps ? 'GPS fix' : 'No GPS fix'}
        </span>
        <span className="status-strip__item">
          <span className="num" style={{ fontWeight: 500 }}>{s.utc}</span>
          {s.timeSource ? <span className={s.timeSource === 'GPS' ? '' : 'strip-warning'}>· {s.timeSource}</span> : null}
        </span>
        <span className="status-strip__item">{s.passage}</span>
      </button>
      <NightToggle />
    </div>
  );
}

const NAV = [
  { to: '/d', label: 'Dashboards', icon: DashboardsIcon, match: ['/d', '/'] },
  { to: '/log', label: 'Logbook', icon: LogIcon, match: ['/log', '/passages'] },
  { to: '/maintenance', label: 'Maintenance', icon: MaintenanceIcon, match: ['/maintenance'] },
  { to: '/anchor', label: 'Anchor watch', icon: AnchorIcon, match: ['/anchor'] },
  { to: '/checklists', label: 'Checklists', icon: ChecklistIcon, match: ['/checklists'] },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings', '/login'] },
];

const TABS = [
  { to: '/d', label: 'Dashboards', icon: DashboardsIcon, match: ['/d', '/'] },
  { to: '/log', label: 'Log', icon: LogIcon, match: ['/log'] },
  { to: '/maintenance', label: 'Maintenance', icon: MaintenanceIcon, match: ['/maintenance'] },
  { to: '/more', label: 'More', icon: MoreIcon, match: ['/more', '/anchor', '/checklists', '/passages', '/settings', '/login'] },
];

function isActive(pathname: string, match: string[]): boolean {
  return match.some((m) => (m === '/' ? pathname === '/' : pathname === m || pathname.startsWith(m + '/')));
}

function Sidebar() {
  const { pathname } = useLocation();
  const s = useStatusSummary();
  const navigate = useNavigate();
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__title">Data Hub</div>
      {NAV.map(({ to, label, icon: Icon, match }) => (
        <NavLink key={to} to={to} aria-current={isActive(pathname, match) ? 'page' : undefined}>
          <Icon size={20} />
          {label}
        </NavLink>
      ))}
      <div className="sidebar__footer">
        <button type="button" className="sidebar__status" onClick={() => navigate('/settings#system')} aria-label="System status. Open settings.">
          <span className="status-strip__item">
            <span className={`dot ${s.dataHub && s.signalk ? '' : 'dot--off'}`} />
            {!s.dataHub ? 'Data Hub lost' : s.signalk === false ? 'Signal K lost' : 'Signal K connected'}
          </span>
          <span className="status-strip__item">
            <span className={`dot ${s.gps ? '' : 'dot--off'}`} />
            {s.gps ? 'GPS fix' : 'No GPS fix'}
            {s.timeSource ? ` · time from ${s.timeSource}` : ''}
          </span>
          <span>
            {s.passage} · <span className="num" style={{ fontWeight: 500 }}>{s.utc}</span>
          </span>
        </button>
        <NightToggle className="sidebar__night" />
      </div>
    </nav>
  );
}

function TabBar() {
  const { pathname } = useLocation();
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ to, label, icon: Icon, match }) => (
        <NavLink key={to} to={to} aria-current={isActive(pathname, match) ? 'page' : undefined}>
          <Icon size={24} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Web Audio tone while an alarm is unacknowledged and the page is visible. A convenience: the real alarm is the onboard sounder. */
function useAlarmTone(active: boolean): void {
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!active) return;
    const beep = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        ctxRef.current ??= new AudioContext();
        const ctx = ctxRef.current;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } catch {
        // Audio blocked until the user interacts with the page; the banner still shows.
      }
    };
    beep();
    const t = window.setInterval(beep, 1000);
    return () => window.clearInterval(t);
  }, [active]);
}

/** Full-width, top of the screen, pushes content down. */
function AlarmBanner() {
  // Re-evaluated every second so a snooze running out brings the banner back.
  const now = useNow(1000);
  const alarm = topAlarm(useAlarms((s) => s.alarms), now);
  const role = useMe().data?.role ?? 'guest';
  useAlarmTone(alarm !== null && !alarm.acked);
  if (!alarm) return null;
  const act = (what: 'ack' | 'snooze') =>
    void api<ActiveAlarm>(`/alarms/${alarm.id}/${what}`, { method: 'POST', body: what === 'snooze' ? { minutes: 2 } : undefined })
      .then((a) => useAlarms.getState().upsert(a))
      .catch(() => undefined);
  const at = new Date(alarm.raisedAt);
  return (
    <div className="alarm-banner" role="alert">
      <div className="alarm-banner__head">
        <span className="alarm-banner__title">{alarm.title}</span>
        <span className="alarm-banner__time">
          {String(at.getHours()).padStart(2, '0')}:{String(at.getMinutes()).padStart(2, '0')} local
        </span>
      </div>
      <div className="alarm-banner__message">{alarm.message}</div>
      {roleAtLeast(role, 'crew') ? (
        <div className="alarm-banner__actions">
          <button type="button" className="alarm-banner__ack" disabled={alarm.acked} onClick={() => act('ack')}>
            {alarm.acked ? 'Acknowledged' : 'Acknowledge'}
          </button>
          <button type="button" className="alarm-banner__snooze" onClick={() => act('snooze')}>
            Snooze 2 min
          </button>
        </div>
      ) : (
        <div className="alarm-banner__actions">
          {/* Silencing is a crew action; a guest helm device signs in with a crew PIN. */}
          <Link to="/login" className="alarm-banner__snooze">
            Sign in with PIN to silence
          </Link>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const reconnecting = useLive((s) => s.connection === 'reconnecting');
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell__column">
        <AlarmBanner />
        {reconnecting ? (
          <div className="offline-strip" role="status">
            Reconnecting to Data Hub. Values on screen go stale as their timeouts pass.
          </div>
        ) : null}
        <StatusStrip />
        <main className="shell__main">{children}</main>
        <TabBar />
      </div>
    </div>
  );
}
