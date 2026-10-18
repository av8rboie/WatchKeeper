import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe, useSetupStatus } from './api/client';
import { DashboardEdit } from './dashboards/DashboardEdit';
import { DashboardsIndex, DashboardView } from './dashboards/DashboardView';
import { useEventBridge } from './live/socket';
import { EntryDetailScreen } from './logbook/EntryDetail';
import { LogbookScreen } from './logbook/Logbook';
import { PassageDetailScreen, PassagesScreen } from './logbook/Passages';
import { QuickEntryScreen } from './logbook/QuickEntry';
import { HelmPinScreen } from './screens/HelmPin';
import { MoreScreen } from './screens/More';
import { Placeholder } from './screens/Placeholder';
import { SetupScreen } from './screens/Setup';
import { SettingsScreen } from './settings/Settings';
import { Shell } from './shell/Shell';

/** Everyone arrives signed in through HA ingress. First run goes to setup. */
function Gate({ children }: { children: ReactNode }) {
  const setup = useSetupStatus();
  const me = useMe();
  useEventBridge(me.isSuccess);
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.isPending) return <div className="login muted">Loading…</div>;
  if (me.isError) return <div className="login warn-box">Could not reach Data Hub. Retrying…</div>;
  return <Shell>{children}</Shell>;
}

const page = (el: ReactNode) => <Gate>{el}</Gate>;

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupScreen />} />
      <Route path="/" element={<Navigate to="/d" replace />} />
      <Route path="/login" element={page(<HelmPinScreen />)} />
      <Route path="/d" element={page(<DashboardsIndex />)} />
      <Route path="/d/:dashboardId" element={page(<DashboardView />)} />
      <Route path="/d/:dashboardId/edit" element={page(<DashboardEdit />)} />
      <Route path="/log" element={page(<LogbookScreen />)} />
      <Route path="/log/new" element={page(<QuickEntryScreen />)} />
      <Route path="/log/:entryId" element={page(<EntryDetailScreen />)} />
      <Route path="/passages" element={page(<PassagesScreen />)} />
      <Route path="/passages/:id" element={page(<PassageDetailScreen />)} />
      <Route path="/maintenance/*" element={page(<Placeholder title="Maintenance" milestone="M4" what="Due list, equipment, parts and pre-departure view." />)} />
      <Route path="/anchor" element={page(<Placeholder title="Anchor watch" milestone="M5" what="Swing circle, drag alarm and GPS-loss alarm." />)} />
      <Route path="/checklists/*" element={page(<Placeholder title="Checklists" milestone="M5" what="Checklist runs that write to the log." />)} />
      <Route path="/more" element={page(<MoreScreen />)} />
      <Route path="/settings" element={page(<SettingsScreen />)} />
      <Route path="*" element={page(<Placeholder title="Not found" what="There is no screen at this address." />)} />
    </Routes>
  );
}
