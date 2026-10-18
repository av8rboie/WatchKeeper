import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, useMe, useSetupStatus } from './api/client';
import { useEventSocket } from './api/events';
import { MoreScreen } from './screens/More';
import { LoginScreen } from './screens/Login';
import { Placeholder } from './screens/Placeholder';
import { SettingsScreen } from './settings/Settings';
import { SetupScreen } from './screens/Setup';
import { Shell } from './shell/Shell';

const LAST_DASHBOARD = 'dh.lastDashboard';

function lastDashboard(): string {
  try {
    return localStorage.getItem(LAST_DASHBOARD) ?? '/d';
  } catch {
    return '/d';
  }
}

/** Sends people to setup on first run and to login without a session. */
function RequireAuth({ children }: { children: ReactNode }) {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();
  const offline = me.error instanceof ApiError && me.error.status === 0;
  useEventSocket(me.isSuccess);

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.isPending && !offline) return <div className="login muted">Loading…</div>;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  // Backend unreachable: keep the shell up so live Signal K values can still show.
  return <Shell>{children}</Shell>;
}

const page = (el: ReactNode) => <RequireAuth>{el}</RequireAuth>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/setup" element={<SetupScreen />} />
      <Route path="/" element={<Navigate to={lastDashboard()} replace />} />
      <Route path="/d" element={page(<Placeholder title="Dashboards" milestone="M2" what="Custom dashboards: widget grid per breakpoint, edit mode, starter dashboards." />)} />
      <Route path="/d/:dashboardId" element={page(<Placeholder title="Dashboard" milestone="M2" what="Dashboard view mode with live Signal K values." />)} />
      <Route path="/d/:dashboardId/edit" element={page(<Placeholder title="Edit dashboard" milestone="M2" what="Edit mode with widget settings and the path browser." />)} />
      <Route path="/log" element={page(<Placeholder title="Logbook" milestone="M3" what="Logbook timeline for the active passage." />)} />
      <Route path="/log/new" element={page(<Placeholder title="Quick entry" milestone="M3" what="Quick log entry." />)} />
      <Route path="/log/:entryId" element={page(<Placeholder title="Log entry" milestone="M3" what="Entry detail, signing and amendments." />)} />
      <Route path="/passages/*" element={page(<Placeholder title="Passages" milestone="M3" what="Passage list, summary and export." />)} />
      <Route path="/maintenance/*" element={page(<Placeholder title="Maintenance" milestone="M4" what="Due list, equipment, parts and pre-departure view." />)} />
      <Route path="/anchor" element={page(<Placeholder title="Anchor watch" milestone="M5" what="Swing circle, drag alarm and GPS-loss alarm." />)} />
      <Route path="/checklists/*" element={page(<Placeholder title="Checklists" milestone="M5" what="Checklist runs that write to the log." />)} />
      <Route path="/more" element={page(<MoreScreen />)} />
      <Route path="/settings" element={page(<SettingsScreen />)} />
      <Route path="*" element={page(<Placeholder title="Not found" what="There is no screen at this address." />)} />
    </Routes>
  );
}
