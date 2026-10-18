import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '@watchkeeper/shared';
import { api, ApiError, useSetupStatus, useSystemStatus } from '../api/client';
import { UnitsForm } from '../settings/UnitsForm';
import { Card, FormField, PrimaryButton, StatusPill } from '../shell/components';

type Step = 'skipper' | 'signalk' | 'units';

/** First run: skipper account, Signal K device approval, units. */
export function SetupScreen() {
  const setup = useSetupStatus();
  const [step, setStep] = useState<Step>('skipper');
  const navigate = useNavigate();

  if (setup.data && !setup.data.needsSetup && step === 'skipper') {
    navigate('/login', { replace: true });
    return null;
  }

  return (
    <main className="login">
      <h1 className="screen-title">Set up Data Hub</h1>
      <div className="login__panel" style={{ maxWidth: 480 }}>
        <div className="label">Step {step === 'skipper' ? 1 : step === 'signalk' ? 2 : 3} of 3</div>
        {step === 'skipper' ? <SkipperStep onDone={() => setStep('signalk')} /> : null}
        {step === 'signalk' ? <SignalKStep onDone={() => setStep('units')} /> : null}
        {step === 'units' ? (
          <Card title="Units">
            <UnitsForm submitLabel="Finish setup" onSaved={() => navigate('/', { replace: true })} />
          </Card>
        ) : null}
      </div>
    </main>
  );
}

function SkipperStep({ onDone }: { onDone(): void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const submit = async () => {
    if (!/^\d{4,8}$/.test(pin)) return setError('PIN is 4 to 8 digits.');
    if (pin !== confirm) return setError('The PINs do not match.');
    try {
      const me = await api<Me>('/setup/skipper', { method: 'POST', body: { name, pin } });
      qc.setQueryData(['me'], me);
      qc.setQueryData(['setup'], { needsSetup: false });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the account.');
    }
  };

  return (
    <Card title="Skipper account">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="muted" style={{ margin: 0 }}>The skipper can change settings, users, thresholds and dashboards.</p>
        <FormField label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}</FormField>
        <div className="grid-2">
          <FormField label="PIN" hint="4 to 8 digits">
            {(id) => <input id={id} className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} required />}
          </FormField>
          <FormField label="Confirm PIN">
            {(id) => <input id={id} className="input" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
          </FormField>
        </div>
        {error ? <div className="field__error" role="alert">{error}</div> : null}
        <PrimaryButton type="submit" disabled={!name.trim()}>Create skipper account</PrimaryButton>
      </form>
    </Card>
  );
}

function SignalKStep({ onDone }: { onDone(): void }) {
  const status = useSystemStatus({ refetchInterval: 2000 });
  const sk = status.data?.signalk;
  return (
    <Card title="Signal K">
      <div className="stack">
        <dl className="kv">
          <dt>Server</dt>
          <dd className="mono">{sk?.url ?? '…'}</dd>
          <dt>Connection</dt>
          <dd>{sk ? <StatusPill tone={sk.connected ? 'good' : 'alarm'}>{sk.connected ? 'Connected' : 'Not connected'}</StatusPill> : '…'}</dd>
          <dt>Device access</dt>
          <dd>{sk ? <StatusPill tone={sk.authorized ? 'good' : 'warn'}>{sk.authorized ? 'Approved' : 'Not approved yet'}</StatusPill> : '…'}</dd>
        </dl>
        {sk && !sk.authorized ? (
          <div className="info-box">
            If Signal K security is on, approve the access request named “Data Hub (backend)” in the Signal K admin UI under Security, then
            Access Requests. Approve “Data Hub (browsers, read only)” as read only. Without security, no approval is needed.
          </div>
        ) : null}
        <p className="muted" style={{ margin: 0 }}>The server address is set during install (SIGNALK_URL in the Data Hub config).</p>
        <PrimaryButton onClick={onDone}>Continue</PrimaryButton>
      </div>
    </Card>
  );
}
