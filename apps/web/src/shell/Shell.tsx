import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, useSystemStatus } from '../api/client';
import { useTheme } from '../theme/theme';
import { topAlarm, useAlarms } from './alarms';
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

export function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function useStatusSummary() {
  const q = useSystemStatus();
  const s = q.data;
  const offline = q.error instanceof ApiError && (q.error.status === 0 || q.error.status >= 502);
  return {
    offline,
    signalk: s ? s.signalk.connected : null,
    gps: s ? s.gps.fix : null,
    clockUnsynced: s?.clock.synced === false,
    /** null when chrony isn't reporting: say nothing rather than claim a sync. */
    clockSynced: s?.clock.synced ?? null,
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

/** Phone and tablet-portrait status strip: Signal K, GPS, UTC, passage, night toggle. */
function StatusStrip() {
  const s = useStatusSummary();
  const utc = useUtcClock();
  const navigate = useNavigate();
  return (
    <div className="status-strip">
      <button type="button" className="status-strip__items" onClick={() => navigate('/settings#system')} aria-label="System status. Open settings.">
        <span className="status-strip__item">
          <span className={`dot ${s.signalk ? '' : 'dot--off'}`} />
          {s.signalk === false ? 'Signal K lost' : 'Signal K'}
        </span>
        <span className="status-strip__item">
          <span className={`dot ${s.gps ? '' : 'dot--off'}`} />
          {s.gps ? 'GPS fix' : 'No GPS fix'}
        </span>
        <span className="status-strip__item num" style={{ fontWeight: 500 }}>
          {utc}
        </span>
        <span className="status-strip__item">{s.passage}</span>
        {s.clockUnsynced ? <span className="status-strip__item strip-warning">Clock not synced</span> : null}
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
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings'] },
];

const TABS = [
  { to: '/d', label: 'Dashboards', icon: DashboardsIcon, match: ['/d', '/'] },
  { to: '/log', label: 'Log', icon: LogIcon, match: ['/log'] },
  { to: '/maintenance', label: 'Maintenance', icon: MaintenanceIcon, match: ['/maintenance'] },
  { to: '/more', label: 'More', icon: MoreIcon, match: ['/more', '/anchor', '/checklists', '/passages', '/settings'] },
];

function isActive(pathname: string, match: string[]): boolean {
  return match.some((m) => (m === '/' ? pathname === '/' : pathname === m || pathname.startsWith(m + '/')));
}

function Sidebar() {
  const { pathname } = useLocation();
  const s = useStatusSummary();
  const utc = useUtcClock();
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
            <span className={`dot ${s.signalk ? '' : 'dot--off'}`} />
            {s.signalk === false ? 'Signal K lost' : 'Signal K connected'}
          </span>
          <span className="status-strip__item">
            <span className={`dot ${s.gps && !s.clockUnsynced ? '' : s.gps ? 'dot--warn' : 'dot--off'}`} />
            {s.gps ? 'GPS fix' : 'No GPS fix'}
            {s.clockSynced === null ? '' : s.clockSynced ? ' · clock synced' : ' · clock not synced'}
          </span>
          <span>
            {s.passage} · <span className="num" style={{ fontWeight: 500 }}>{utc}</span>
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

/** Web Audio tone while an alarm is unacknowledged and the page is visible. A convenience: the real alarm is on the Pi. */
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
  const alarm = topAlarm(useAlarms((s) => s.alarms));
  useAlarmTone(alarm !== null && !alarm.acked);
  if (!alarm) return null;
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
      <div className="alarm-banner__actions">
        <button type="button" className="alarm-banner__ack" disabled={alarm.acked} onClick={() => void api(`/alarms/${alarm.id}/ack`, { method: 'POST' })}>
          {alarm.acked ? 'Acknowledged' : 'Acknowledge'}
        </button>
        <button type="button" className="alarm-banner__snooze" onClick={() => void api(`/alarms/${alarm.id}/snooze`, { method: 'POST', body: { minutes: 2 } })}>
          Snooze 2 min
        </button>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { offline } = useStatusSummary();
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell__column">
        <AlarmBanner />
        {offline ? (
          <div className="offline-strip" role="status">
            Data Hub offline, retrying
          </div>
        ) : null}
        <StatusStrip />
        <main className="shell__main">{children}</main>
        <TabBar />
      </div>
    </div>
  );
}
