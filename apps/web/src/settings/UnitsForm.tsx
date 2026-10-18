import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DEFAULT_UNIT_PREFS, UnitPrefsSchema, type Me, type UnitPrefs } from '@watchkeeper/shared';
import { api, useMe } from '../api/client';
import { FormField, PrimaryButton } from '../shell/components';

const LABELS: Record<keyof UnitPrefs, string> = {
  speed: 'Speed',
  depth: 'Depth',
  distance: 'Distance',
  temperature: 'Temperature',
  pressure: 'Barometer',
  enginePressure: 'Engine pressure',
  volume: 'Volume',
  flow: 'Fuel flow',
  heading: 'Headings and courses',
  windAngle: 'Wind angle',
  position: 'Position',
};

const OPTION_LABELS: Record<string, string> = {
  true: 'True',
  magnetic: 'Magnetic',
  sided: '0 to 180° with PORT / STBD',
  signed: 'Signed degrees',
  ddm: 'Degrees, decimal minutes',
  dms: 'Degrees, minutes, seconds',
  dd: 'Decimal degrees',
};

export function UnitsForm({ submitLabel = 'Save units', onSaved, disabled }: { submitLabel?: string; onSaved?(): void; disabled?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState<UnitPrefs>(me.data?.unitPrefs ?? DEFAULT_UNIT_PREFS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me.data) setPrefs(me.data.unitPrefs);
  }, [me.data]);

  const save = async () => {
    const updated = await api<Me>('/auth/me/units', { method: 'PUT', body: prefs });
    qc.setQueryData(['me'], updated);
    setSaved(true);
    onSaved?.();
  };

  const keys = Object.keys(LABELS) as (keyof UnitPrefs)[];
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid-2">
        {keys.map((k) => {
          const options = UnitPrefsSchema.shape[k].removeDefault().options as readonly string[];
          return (
            <FormField key={k} label={LABELS[k]}>
              {(id) => (
                <select
                  id={id}
                  className="select"
                  value={prefs[k]}
                  disabled={disabled}
                  onChange={(e) => { setSaved(false); setPrefs({ ...prefs, [k]: e.target.value }); }}
                >
                  {options.map((o) => (
                    <option key={o} value={o}>
                      {OPTION_LABELS[o] ?? o}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          );
        })}
      </div>
      {disabled ? null : (
        <div className="row">
          <PrimaryButton type="submit">{submitLabel}</PrimaryButton>
          {saved ? <span className="muted" role="status">Saved</span> : null}
        </div>
      )}
    </form>
  );
}
