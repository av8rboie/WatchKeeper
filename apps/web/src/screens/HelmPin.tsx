import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '@watchkeeper/shared';
import { api, ApiError, useMe, usePinUsers } from '../api/client';
import { Button, Card } from '../shell/components';
import { BackIcon } from '../shell/icons';

const MAX_PIN = 8;

/**
 * Shared helm devices are signed in to HA as a guest. A crew member enters
 * their PIN here to act as crew on this device for 12 hours.
 */
export function HelmPinScreen() {
  const me = useMe().data;
  const pinUsers = usePinUsers();
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const submit = async (value: string) => {
    if (!user || value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Me>('/auth/pin', { method: 'POST', body: { userId: user.id, pin: value } });
      qc.setQueryData(['me'], updated);
      navigate('/', { replace: true });
    } catch (e) {
      setPin('');
      if (e instanceof ApiError && e.status === 423) setError('Too many wrong PINs. Locked for 5 minutes.');
      else if (e instanceof ApiError && e.status === 401) setError('Wrong PIN.');
      else setError('Data Hub unreachable. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    await api('/auth/pin', { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['me'] });
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

  if (me?.actingAs) {
    return (
      <>
        <div className="screen-head">
          <h1 className="screen-title">Helm sign-in</h1>
        </div>
        <Card>
          <div className="stack">
            <p style={{ margin: 0 }}>
              This device is acting as <b>{me.actingAs.name}</b> (crew) until {new Date(me.actingAs.until).toLocaleTimeString()}.
            </p>
            <div>
              <Button onClick={() => void end()}>End and return to guest</Button>
            </div>
          </div>
        </Card>
      </>
    );
  }

  if (me && me.role !== 'guest') {
    return (
      <>
        <div className="screen-head">
          <h1 className="screen-title">Helm sign-in</h1>
        </div>
        <Card>
          <p style={{ margin: 0 }}>You are signed in to Home Assistant as {me.name} ({me.role}). A helm PIN is only needed on shared guest devices.</p>
        </Card>
      </>
    );
  }

  return (
    <div className="login" style={{ minHeight: 0, padding: '8px 0' }}>
      <h1 className="screen-title">Helm sign-in</h1>
      <div className="login__panel">
        {!user ? (
          <>
            <div className="label">Who is on watch?</div>
            {pinUsers.data?.length === 0 ? <div className="info-box">No crew have a helm PIN yet. The skipper sets PINs under Settings, Roles.</div> : null}
            {(pinUsers.data ?? []).map((u) => (
              <button key={u.id} type="button" className="user-pick" onClick={() => setUser(u)}>
                {u.name}
                <span className="label">crew</span>
              </button>
            ))}
          </>
        ) : (
          <Card>
            <div className="stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="icon-button" aria-label="Choose a different person" onClick={() => { setUser(null); setPin(''); setError(null); }}>
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
                  Sign in
                </button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
