import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { roleAtLeast, type Role } from '@watchkeeper/shared';
import { api, ApiError, useMe, useSystemStatus, useUsers } from '../api/client';
import { Button, Card, FormField, PrimaryButton, SegmentedControl, StatusPill, formatAge } from '../shell/components';
import { useTheme } from '../theme/theme';
import { PathBrowser } from './PathBrowser';
import { UnitsForm } from './UnitsForm';

function bytes(n: number | null): string {
  if (n === null) return 'unknown';
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function SystemCard() {
  const s = useSystemStatus().data;
  if (!s) return <Card title="System status">Loading…</Card>;
  return (
    <Card title="System status">
      <dl className="kv" id="system">
        <dt>Signal K</dt>
        <dd>
          <StatusPill tone={s.signalk.connected ? 'good' : 'alarm'}>{s.signalk.connected ? 'Connected' : 'Not connected'}</StatusPill>{' '}
          <span className="mono">{s.signalk.url}</span>
        </dd>
        <dt>Device access</dt>
        <dd>{s.signalk.authorized ? 'Approved' : 'No token (fine if Signal K security is off)'}</dd>
        <dt>GPS</dt>
        <dd>{s.gps.fix ? `Fix, ${formatAge(s.gps.ageMs)} old` : <StatusPill tone="warn">No fix</StatusPill>}</dd>
        <dt>Clock</dt>
        <dd>
          {s.clock.synced === null ? (
            'Not reported (chrony not available)'
          ) : s.clock.synced ? (
            `Synced${s.clock.source ? ` to ${s.clock.source}` : ''}${s.clock.offsetMs !== null ? `, offset ${s.clock.offsetMs.toFixed(1)} ms` : ''}`
          ) : (
            <StatusPill tone="warn">Not synced</StatusPill>
          )}
        </dd>
        <dt>Disk free</dt>
        <dd>
          {bytes(s.disk.freeBytes)} of {bytes(s.disk.totalBytes)}
        </dd>
        <dt>Last backup</dt>
        <dd>{s.lastBackup ?? 'None yet'}</dd>
        <dt>Version</dt>
        <dd>{s.version}</dd>
      </dl>
    </Card>
  );
}

function UsersCard() {
  const users = useUsers();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('crew');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    try {
      await api('/users', { method: 'POST', body: { name, role, pin } });
      setName('');
      setPin('');
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the user.');
    }
  };

  return (
    <Card title="Users">
      <div className="stack">
        <ul className="menu-list" style={{ gap: 4 }}>
          {(users.data ?? []).map((u) => (
            <li key={u.id} className="row" style={{ justifyContent: 'space-between', minHeight: 44 }}>
              <span style={{ fontWeight: 600 }}>{u.name}</span>
              <span className="label">{u.role}</span>
            </li>
          ))}
        </ul>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="grid-2">
            <FormField label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} required />}</FormField>
            <FormField label="PIN" hint="4 to 8 digits">
              {(id) => <input id={id} className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} required />}
            </FormField>
          </div>
          <SegmentedControl<Role>
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: 'crew', label: 'Crew' },
              { value: 'guest', label: 'Guest' },
              { value: 'skipper', label: 'Skipper' },
            ]}
          />
          {error ? <div className="field__error" role="alert">{error}</div> : null}
          <div>
            <PrimaryButton type="submit">Add user</PrimaryButton>
          </div>
        </form>
      </div>
    </Card>
  );
}

export function SettingsScreen() {
  const me = useMe().data;
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const role = me?.role ?? 'guest';

  useEffect(() => {
    if (location.hash === '#system') document.getElementById('system')?.scrollIntoView();
  }, []);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    navigate('/login', { replace: true });
  };

  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">Settings</h1>
        <Button onClick={() => void logout()}>Sign out{me ? ` ${me.name}` : ''}</Button>
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
      <Card title="Units">
        {roleAtLeast(role, 'crew') ? <UnitsForm /> : <p className="muted" style={{ margin: 0 }}>Guests use the default units.</p>}
      </Card>
      <Card title="Signal K paths">
        <PathBrowser />
      </Card>
      {roleAtLeast(role, 'skipper') ? <UsersCard /> : null}
    </>
  );
}
