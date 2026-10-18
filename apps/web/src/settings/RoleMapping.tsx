import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Role, UserMapping } from '@watchkeeper/shared';
import { api, ApiError, useUserMappings } from '../api/client';
import { FormField, PrimaryButton, SegmentedControl, StatusPill } from '../shell/components';

interface Draft {
  role: Role;
  pin: string;
}

/**
 * The skipper maps HA users to roles. Anyone who has opened Data Hub through
 * HA appears here; unmapped users are guests. Crew can have a helm PIN for
 * shared guest devices.
 */
export function RoleMapping({ onSaved, submitLabel = 'Save roles' }: { onSaved?(): void; submitLabel?: string }) {
  const users = useUserMappings();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (users.data) setDraft(Object.fromEntries(users.data.map((u) => [u.id, { role: u.role, pin: '' }])));
  }, [users.data]);

  const save = async () => {
    setError(null);
    const changes = (users.data ?? [])
      .map((u: UserMapping) => {
        const d = draft[u.id];
        if (!d) return null;
        const roleChanged = d.role !== u.role || !u.mapped;
        if (!roleChanged && !d.pin) return null;
        return { id: u.id, role: d.role, ...(d.pin ? { pin: d.pin } : {}) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    try {
      if (changes.length > 0) await api('/users', { method: 'PUT', body: { users: changes } });
      await qc.invalidateQueries({ queryKey: ['users'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save roles.');
    }
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="muted" style={{ margin: 0 }}>
        Everyone who has opened Data Hub in Home Assistant is listed. Unmapped users are guests: they can read dashboards only.
      </p>
      {(users.data ?? []).map((u) => {
        const d = draft[u.id] ?? { role: u.role, pin: '' };
        return (
          <div key={u.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700 }}>{u.name}</span>
              <span className="row">
                {u.mapped ? null : <StatusPill>Unmapped</StatusPill>}
                {u.hasPin ? <StatusPill tone="good">Helm PIN set</StatusPill> : null}
              </span>
            </div>
            <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
              <SegmentedControl<Role>
                label={`Role for ${u.name}`}
                value={d.role}
                onChange={(role) => { setSaved(false); setDraft({ ...draft, [u.id]: { ...d, role } }); }}
                options={[
                  { value: 'guest', label: 'Guest' },
                  { value: 'crew', label: 'Crew' },
                  { value: 'skipper', label: 'Skipper' },
                ]}
              />
              {d.role !== 'guest' ? (
                <div style={{ width: 180 }}>
                  <FormField label={u.hasPin ? 'New helm PIN' : 'Helm PIN (optional)'}>
                    {(id) => (
                      <input
                        id={id}
                        className="input"
                        type="password"
                        inputMode="numeric"
                        autoComplete="new-password"
                        pattern="\d{4,8}"
                        value={d.pin}
                        onChange={(e) => { setSaved(false); setDraft({ ...draft, [u.id]: { ...d, pin: e.target.value } }); }}
                      />
                    )}
                  </FormField>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      {error ? <div className="field__error" role="alert">{error}</div> : null}
      <div className="row">
        <PrimaryButton type="submit">{submitLabel}</PrimaryButton>
        {saved ? <span className="muted" role="status">Saved</span> : null}
      </div>
    </form>
  );
}
