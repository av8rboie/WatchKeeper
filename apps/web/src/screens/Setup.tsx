import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { Me } from '@watchkeeper/shared';
import { api, ApiError, useMe, useSetupStatus, useSystemStatus } from '../api/client';
import { RoleMapping } from '../settings/RoleMapping';
import { UnitsForm } from '../settings/UnitsForm';
import { Card, PrimaryButton, StatusPill } from '../shell/components';

type Step = 'claim' | 'signalk' | 'roles' | 'units';
const STEPS: Step[] = ['claim', 'signalk', 'roles', 'units'];

/** First run: claim the skipper role, approve the Signal K device, map HA users to roles, units. */
export function SetupScreen() {
  const setup = useSetupStatus();
  const me = useMe();
  const [step, setStep] = useState<Step>('claim');
  const navigate = useNavigate();

  // Setup is done and this person didn't just claim it: nothing to do here.
  if (setup.data && !setup.data.needsSetup && step === 'claim') return <Navigate to="/" replace />;

  return (
    <main className="login">
      <h1 className="screen-title">Set up Data Hub</h1>
      <div className="login__panel" style={{ maxWidth: 560 }}>
        <div className="label">
          Step {STEPS.indexOf(step) + 1} of {STEPS.length}
        </div>
        {step === 'claim' ? <ClaimStep name={me.data?.name ?? 'you'} onDone={() => setStep('signalk')} /> : null}
        {step === 'signalk' ? <SignalKStep onDone={() => setStep('roles')} /> : null}
        {step === 'roles' ? (
          <Card title="Crew and roles">
            <RoleMapping submitLabel="Save and continue" onSaved={() => setStep('units')} />
          </Card>
        ) : null}
        {step === 'units' ? (
          <Card title="Your units">
            <UnitsForm submitLabel="Finish setup" onSaved={() => navigate('/', { replace: true })} />
          </Card>
        ) : null}
      </div>
    </main>
  );
}

function ClaimStep({ name, onDone }: { name: string; onDone(): void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    try {
      const me = await api<Me>('/setup/claim', { method: 'POST' });
      qc.setQueryData(['me'], me);
      qc.setQueryData(['setup'], { needsSetup: false });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not claim the skipper role.');
    }
  };
  return (
    <Card title="Skipper">
      <div className="stack">
        <p style={{ margin: 0 }}>
          Data Hub has no skipper yet. Signed in to Home Assistant as <b>{name}</b>, you can claim the role. The skipper maps everyone else to
          crew or guest.
        </p>
        {error ? <div className="field__error" role="alert">{error}</div> : null}
        <PrimaryButton onClick={() => void claim()}>I am the skipper</PrimaryButton>
      </div>
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
          <dd>
            {sk ? (
              <StatusPill tone={sk.authorized ? 'good' : 'warn'}>
                {sk.authorized ? 'Approved' : sk.accessRequest === 'pending' ? 'Waiting for approval' : 'Not approved'}
              </StatusPill>
            ) : (
              '…'
            )}
          </dd>
        </dl>
        {sk && !sk.authorized ? (
          <div className="info-box">
            Open the Signal K add-on's web UI, go to Security, then Access Requests, and approve “Data Hub” with read/write permission.
          </div>
        ) : null}
        <p className="muted" style={{ margin: 0 }}>The server address is the add-on option signalk_url.</p>
        <PrimaryButton onClick={onDone}>Continue</PrimaryButton>
      </div>
    </Card>
  );
}
