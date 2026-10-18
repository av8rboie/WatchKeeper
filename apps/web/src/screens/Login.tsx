import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Me, UserPublic } from '@watchkeeper/shared';
import { api, ApiError, useSetupStatus, useUsers } from '../api/client';
import { Card } from '../shell/components';
import { BackIcon } from '../shell/icons';

const MAX_PIN = 8;

export function LoginScreen() {
  const users = useUsers();
  const setup = useSetupStatus();
  const [user, setUser] = useState<UserPublic | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  const submit = async (value: string) => {
    if (!user || value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>('/auth/login', { method: 'POST', body: { userId: user.id, pin: value } });
      qc.setQueryData(['me'], me);
      navigate(from, { replace: true });
    } catch (e) {
      setPin('');
      if (e instanceof ApiError && e.status === 423) setError('Too many wrong PINs. Locked for 5 minutes.');
      else if (e instanceof ApiError && e.status === 401) setError('Wrong PIN.');
      else setError('Data Hub offline. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const press = (d: string) => setPin((p) => (p.length < MAX_PIN ? p + d : p));

  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submit(pin);
      else if (e.key === 'Escape') setUser(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  return (
    <main className="login">
      <h1 className="screen-title">Data Hub</h1>
      <div className="login__panel">
        {!user ? (
          <>
            <div className="label">Who is signing in?</div>
            {users.isError ? <div className="warn-box">Data Hub offline, retrying.</div> : null}
            {(users.data ?? []).map((u) => (
              <button key={u.id} type="button" className="user-pick" onClick={() => setUser(u)}>
                {u.name}
                <span className="label">{u.role}</span>
              </button>
            ))}
          </>
        ) : (
          <Card>
            <div className="stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="icon-button" aria-label="Choose a different user" onClick={() => { setUser(null); setPin(''); setError(null); }}>
                  <BackIcon />
                </button>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{user.name}</span>
                <span style={{ width: 44 }} />
              </div>
              <div className="pin-dots" aria-label={`${pin.length} digits entered`} role="status">
                {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                  <span key={i} data-filled={i < pin.length} />
                ))}
              </div>
              {error ? (
                <div className="field__error" role="alert" style={{ textAlign: 'center' }}>
                  {error}
                </div>
              ) : null}
              <div className="pin-pad">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button key={d} type="button" onClick={() => press(d)}>
                    {d}
                  </button>
                ))}
                <button type="button" className="pin-pad__aux" onClick={() => setPin('')}>
                  Clear
                </button>
                <button type="button" onClick={() => press('0')}>
                  0
                </button>
                <button type="button" className="pin-pad__aux" disabled={pin.length < 4 || busy} onClick={() => void submit(pin)}>
                  Unlock
                </button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
