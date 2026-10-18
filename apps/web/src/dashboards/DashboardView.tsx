import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { roleAtLeast, type DashboardSummary } from '@watchkeeper/shared';
import { ApiError, useMe } from '../api/client';
import { Card, PrimaryButton } from '../shell/components';
import { useDashboard, useDashboardMutations, useDashboards } from './api';
import { DashboardGrid } from './DashboardGrid';
import { useKeepScreenOn, useViewportBreakpoint, useWakeLock } from './hooks';

export const LAST_DASHBOARD = 'dh.lastDashboard';

function remember(id: string) {
  try {
    localStorage.setItem(LAST_DASHBOARD, `/d/${id}`);
  } catch {
    // Storage unavailable: / goes to the first dashboard.
  }
}

/** Desktop and tablet: dashboards as tabs. */
export function DashboardTabs({ list, current, trailing, edit }: { list: DashboardSummary[]; current: string; trailing?: ReactNode; edit?: boolean }) {
  return (
    <nav className="dash-tabs" aria-label="Dashboards">
      {list.map((d) => (
        <Link key={d.id} to={`/d/${d.id}${edit ? '/edit' : ''}`} aria-current={d.id === current ? 'page' : undefined} className="dash-tabs__tab">
          {d.name}
        </Link>
      ))}
      {trailing}
    </nav>
  );
}

/** / and /d: the last-viewed dashboard, or the first, or an empty state. */
export function DashboardsIndex() {
  const list = useDashboards();
  const role = useMe().data?.role ?? 'guest';
  const { starter, create } = useDashboardMutations();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (list.isPending) return <div className="muted">Loading dashboards…</div>;
  const dashboards = list.data ?? [];
  if (dashboards.length > 0) {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_DASHBOARD);
    } catch {
      last = null;
    }
    const target = last && dashboards.some((d) => `/d/${d.id}` === last) ? last : `/d/${dashboards[0]!.id}`;
    return <Navigate to={target} replace />;
  }
  const makeStarter = async () => {
    try {
      const made = await starter();
      if (made[0]) navigate(`/d/${made[0].id}`);
      else setError('Signal K is not publishing anything yet, so there was nothing to put on a starter dashboard.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create dashboards.');
    }
  };
  const makeEmpty = async () => {
    try {
      const d = await create({ name: 'New dashboard', widgets: [] });
      navigate(`/d/${d.id}/edit`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the dashboard.');
    }
  };
  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">Dashboards</h1>
      </div>
      <Card title="No dashboards yet">
        {roleAtLeast(role, 'skipper') ? (
          <div className="stack">
            <p style={{ margin: 0 }}>Start with Helm, Engines, Energy and Anchor, built from the paths Signal K is publishing right now, or start empty.</p>
            {error ? (
              <div className="field__error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="row" style={{ gap: 10 }}>
              <PrimaryButton onClick={() => void makeStarter()}>Create starter dashboards</PrimaryButton>
              <button type="button" className="button" onClick={() => void makeEmpty()}>
                New empty dashboard
              </button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            The skipper hasn't set up any dashboards yet.
          </p>
        )}
      </Card>
    </>
  );
}

/** Phone: swipe left and right between dashboards. Vertical scrolling is left alone. */
function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = t ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current;
      const t = e.changedTouches[0];
      start.current = null;
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) (dx < 0 ? onLeft : onRight)();
    },
  };
}

/** /d/:dashboardId, view mode. Locked layout for this device's breakpoint. */
export function DashboardView() {
  const { dashboardId } = useParams();
  const list = useDashboards().data ?? [];
  const dash = useDashboard(dashboardId);
  const me = useMe().data;
  const bp = useViewportBreakpoint();
  const navigate = useNavigate();
  const keepOn = useKeepScreenOn((s) => s.on);
  useWakeLock(keepOn);
  const index = list.findIndex((d) => d.id === dashboardId);
  const go = (delta: number) => {
    const next = list[index + delta];
    if (next) navigate(`/d/${next.id}`);
  };
  const swipe = useSwipe(
    () => go(1),
    () => go(-1),
  );

  useEffect(() => {
    if (dash.data) remember(dash.data.id);
  }, [dash.data]);

  if (dash.isError) {
    if (dash.error instanceof ApiError && dash.error.status === 404) return <Navigate to="/d" replace />;
    return <div className="warn-box">Could not load this dashboard.</div>;
  }
  if (!dash.data) return <div className="muted">Loading…</div>;
  const d = dash.data;
  const canEdit = me ? roleAtLeast(me.role, 'skipper') : false;
  const editLink = canEdit ? (
    <Link to={`/d/${d.id}/edit`} className="button dash-edit-link">
      Edit
    </Link>
  ) : null;

  return (
    <div className="dashboard" {...(bp === 'phone' ? swipe : {})}>
      {bp === 'phone' ? (
        <div className="dash-head">
          <h1 className="screen-title">{d.name}</h1>
          <div className="row" style={{ gap: 10 }}>
            {list.length > 1 ? (
              <div className="dash-dots" role="img" aria-label={`Dashboard ${index + 1} of ${list.length}`}>
                {list.map((x) => (
                  <span key={x.id} className={x.id === d.id ? 'dash-dots__on' : ''} />
                ))}
              </div>
            ) : null}
            {editLink}
          </div>
        </div>
      ) : (
        <div className="dash-head">
          <h1 className="sr-only">{d.name}</h1>
          <DashboardTabs list={list} current={d.id} />
          {editLink}
        </div>
      )}
      {d.widgets.length === 0 ? (
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            No widgets on this dashboard yet.{canEdit ? ' Use Edit to add some.' : ''}
          </p>
        </Card>
      ) : (
        <DashboardGrid dashboard={d} breakpoint={bp} />
      )}
    </div>
  );
}
