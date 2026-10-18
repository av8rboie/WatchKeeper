import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { roleAtLeast } from '@watchkeeper/shared';
import { useMe, useSystemStatus } from '../api/client';
import { Card, SegmentedControl, StatusPill, formatAge } from '../shell/components';
import { useTheme } from '../theme/theme';
import { PathBrowser } from './PathBrowser';
import { RoleMapping } from './RoleMapping';
import { UnitsForm } from './UnitsForm';

function bytes(n: number | null): string {
  if (n === null) return 'unknown';
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function SystemCard() {
  const s = useSystemStatus().data;
  if (!s) return <Card title="System status">Loading…</Card>;
  const drift = s.time.driftMs;
  return (
    <Card title="System status">
      <dl className="kv" id="system">
        <dt>Signal K</dt>
        <dd>
          <StatusPill tone={s.signalk.connected ? 'good' : 'alarm'}>{s.signalk.connected ? 'Connected' : 'Not connected'}</StatusPill>{' '}
          <span className="mono">{s.signalk.url}</span>
        </dd>
        <dt>Device access</dt>
        <dd>
          {s.signalk.authorized
            ? 'Approved'
            : s.signalk.accessRequest === 'pending'
              ? 'Waiting for approval in Signal K'
              : s.signalk.accessRequest === 'not-required'
                ? 'Not required (Signal K security is off)'
                : s.signalk.accessRequest === 'denied'
                  ? 'Denied in Signal K'
                  : 'No token yet'}
        </dd>
        <dt>GPS</dt>
        <dd>{s.gps.fix ? `Fix, ${formatAge(s.gps.ageMs)} old` : <StatusPill tone="warn">No fix</StatusPill>}</dd>
        <dt>Log time</dt>
        <dd>
          {s.time.source === 'gps' ? 'GPS' : <StatusPill tone="warn">Host clock (GPS time stale)</StatusPill>}
          {drift !== null ? ` · host clock ${Math.abs(drift) < 1000 ? 'within 1 s' : `${(drift / 1000).toFixed(1)} s off`}` : ''}
        </dd>
        <dt>CPU temperature</dt>
        <dd>
          {s.cpuTempC === null ? (
            'Not available'
          ) : s.cpuTempC >= 78 ? (
            <StatusPill tone="alarm">{s.cpuTempC.toFixed(0)} °C, near throttling</StatusPill>
          ) : s.cpuTempC >= 70 ? (
            <StatusPill tone="warn">{s.cpuTempC.toFixed(0)} °C, hot</StatusPill>
          ) : (
            `${s.cpuTempC.toFixed(0)} °C`
          )}
        </dd>
        <dt>Disk free</dt>
        <dd>
          {bytes(s.disk.freeBytes)} of {bytes(s.disk.totalBytes)}
        </dd>
        <dt>Last backup snapshot</dt>
        <dd>{s.lastSnapshot ? new Date(s.lastSnapshot).toLocaleString() : 'None yet'}</dd>
        <dt>Version</dt>
        <dd>{s.version}</dd>
      </dl>
    </Card>
  );
}

export function SettingsScreen() {
  const me = useMe().data;
  const { theme, setTheme } = useTheme();
  const role = me?.role ?? 'guest';

  useEffect(() => {
    if (location.hash === '#system') document.getElementById('system')?.scrollIntoView();
  }, []);

  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">Settings</h1>
        {me ? (
          <span className="muted" style={{ fontSize: 14 }}>
            {me.actingAs ? `${me.name}, acting as ${me.actingAs.name}` : me.name} · {role}
          </span>
        ) : null}
      </div>
      <SystemCard />
      <Card title="Display on this device">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'night', label: 'Night' },
          ]}
        />
      </Card>
      {role === 'guest' || me?.actingAs ? (
        <Card title="Helm sign-in">
          <p style={{ margin: '0 0 10px' }}>
            {me?.actingAs ? `Acting as ${me.actingAs.name} until ${new Date(me.actingAs.until).toLocaleTimeString()}.` : 'Shared helm device? Crew can sign in with their PIN.'}
          </p>
          <Link to="/login" className="button">
            {me?.actingAs ? 'Manage helm sign-in' : 'Sign in with PIN'}
          </Link>
        </Card>
      ) : null}
      <Card title="Units">
        {roleAtLeast(role, 'crew') && !me?.actingAs ? <UnitsForm /> : <p className="muted" style={{ margin: 0 }}>Units are saved per Home Assistant user; guests use the defaults.</p>}
      </Card>
      {roleAtLeast(role, 'skipper') ? (
        <Card title="Roles">
          <RoleMapping />
        </Card>
      ) : null}
      <Card title="Signal K paths">
        <PathBrowser />
      </Card>
    </>
  );
}
