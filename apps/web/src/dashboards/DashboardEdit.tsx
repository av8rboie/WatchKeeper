import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { BREAKPOINTS, roleAtLeast, WIDGET_TYPES, type Breakpoint, type Dashboard, type LayoutItem, type Widget, type WidgetType } from '@watchkeeper/shared';
import { ApiError, useMe } from '../api/client';
import { Button, FormField, PrimaryButton, SegmentedControl } from '../shell/components';
import { useDashboard, useDashboardMutations, useDashboards } from './api';
import { DashboardGrid } from './DashboardGrid';
import { DashboardTabs } from './DashboardView';
import { useViewportBreakpoint } from './hooks';
import { WidgetSettings } from './WidgetSettings';
import { WIDGETS } from './widgets';

const BP_LABEL: Record<Breakpoint, string> = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
/** The canvas is drawn at a representative width for the layout being edited. */
const PREVIEW_WIDTH: Record<Breakpoint, number | null> = { phone: 390, tablet: 768, desktop: null };

const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Saves are queued so they reach the server in order, and debounced so a drag
 * or a typed label doesn't send a request per pixel or keystroke. A server
 * reply replaces the local draft only if nothing changed locally meanwhile.
 */
function useSaver(id: string | undefined, setDraft: (d: Dashboard) => void) {
  const { setLayouts, replace } = useDashboardMutations();
  const version = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timers = useRef<{ layout?: number; widgets?: number }>({});
  const pendingLayouts = useRef<Partial<Record<Breakpoint, LayoutItem[]>>>({});
  const pendingWidgets = useRef<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);

  const run = useCallback(
    (fn: () => Promise<Dashboard>) => {
      setSaving((n) => n + 1);
      chain.current = chain.current
        .then(() => {
          const sent = version.current;
          return fn().then((d) => {
            setError(null);
            if (version.current === sent) setDraft(d);
          });
        })
        .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not save. Check the connection to Data Hub.'))
        .finally(() => setSaving((n) => n - 1));
      return chain.current;
    },
    [setDraft],
  );

  const flushLayouts = useCallback(() => {
    window.clearTimeout(timers.current.layout);
    const layouts = pendingLayouts.current;
    pendingLayouts.current = {};
    if (id && Object.keys(layouts).length > 0) return run(() => setLayouts(id, layouts));
    return chain.current;
  }, [id, run, setLayouts]);

  const flushWidgets = useCallback(() => {
    window.clearTimeout(timers.current.widgets);
    const d = pendingWidgets.current;
    pendingWidgets.current = null;
    if (id && d) return run(() => replace(id, { name: d.name, sort: d.sort, widgets: d.widgets }));
    return chain.current;
  }, [id, run, replace]);

  return {
    error,
    saving: saving > 0,
    layout(bp: Breakpoint, items: LayoutItem[]) {
      version.current++;
      pendingLayouts.current[bp] = items;
      window.clearTimeout(timers.current.layout);
      timers.current.layout = window.setTimeout(() => void flushLayouts(), 400);
    },
    /** `immediate` for adds and removes: the reply carries the server's placement of a new widget. */
    widgets(d: Dashboard, immediate = false) {
      version.current++;
      pendingWidgets.current = d;
      window.clearTimeout(timers.current.widgets);
      if (immediate) {
        void flushLayouts();
        void flushWidgets();
      } else {
        timers.current.widgets = window.setTimeout(() => void flushWidgets(), 600);
      }
    },
    async flush() {
      await flushLayouts();
      await flushWidgets();
    },
  };
}

/** /d/:dashboardId/edit: widget settings, path browser, and one layout per breakpoint. */
export function DashboardEdit() {
  const { dashboardId } = useParams();
  const me = useMe().data;
  const list = useDashboards().data ?? [];
  const dash = useDashboard(dashboardId);
  const viewportBp = useViewportBreakpoint();
  const navigate = useNavigate();
  const { create, remove } = useDashboardMutations();
  const [bp, setBp] = useState<Breakpoint>(viewportBp);
  const [draft, setDraftState] = useState<Dashboard | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [addType, setAddType] = useState<WidgetType>('numeric');
  const setDraft = useCallback((d: Dashboard) => setDraftState(d), []);
  const saver = useSaver(dashboardId, setDraft);
  const dirty = useRef(false);

  // Take the server's copy on first load, on switching dashboards, and when
  // another client saves while nothing here is unsaved.
  useEffect(() => {
    if (!dash.data) return;
    const switched = !draft || draft.id !== dash.data.id;
    if (switched || (!dirty.current && !saver.saving)) {
      setDraftState(dash.data);
      setName(dash.data.name);
      if (switched) setSelected(null);
    }
  }, [dash.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!saver.saving) dirty.current = false;
  }, [saver.saving]);

  if (me && !roleAtLeast(me.role, 'skipper')) return <Navigate to={`/d/${dashboardId}`} replace />;
  if (dash.isError) return <Navigate to="/d" replace />;
  if (!draft) return <div className="muted">Loading…</div>;

  const widget = draft.widgets.find((w) => w.id === selected) ?? null;
  const edit = (d: Dashboard, immediate = false) => {
    dirty.current = true;
    setDraftState(d);
    saver.widgets(d, immediate);
  };
  const setLayout = (items: LayoutItem[]) => {
    dirty.current = true;
    setDraftState((d) => (d ? { ...d, layouts: { ...d.layouts, [bp]: items } } : d));
    saver.layout(bp, items);
  };
  const updateWidget = (w: Widget) => edit({ ...draft, widgets: draft.widgets.map((x) => (x.id === w.id ? w : x)) });
  const addWidget = () => {
    const w: Widget = { id: newId(), type: addType, ...WIDGETS[addType].defaults() };
    edit({ ...draft, widgets: [...draft.widgets, w] }, true);
    setSelected(w.id);
  };
  const removeWidget = (id: string) => {
    setSelected(null);
    edit({ ...draft, widgets: draft.widgets.filter((w) => w.id !== id) }, true);
  };
  const done = async () => {
    await saver.flush();
    navigate(`/d/${draft.id}`);
  };
  const newDashboard = async () => {
    await saver.flush();
    const d = await create({ name: 'New dashboard', widgets: [] });
    navigate(`/d/${d.id}/edit`);
  };
  const deleteDashboard = async () => {
    if (!window.confirm(`Delete the ${draft.name} dashboard? This can't be undone.`)) return;
    await remove(draft.id);
    navigate('/d', { replace: true });
  };

  const preview = PREVIEW_WIDTH[bp];
  const others = BREAKPOINTS.filter((b) => b !== bp).map((b) => BP_LABEL[b]);

  return (
    <div className="edit-page">
      <div className="edit-page__main">
        <div className="edit-toolbar">
          <DashboardTabs
            list={list}
            current={draft.id}
            edit
            trailing={
              <button type="button" className="dash-tabs__tab dash-tabs__new" onClick={() => void newDashboard()}>
                + New
              </button>
            }
          />
          <div className="row" style={{ gap: 8 }}>
            <SegmentedControl<Breakpoint> label="Layout being edited" value={bp} onChange={setBp} options={BREAKPOINTS.map((b) => ({ value: b, label: BP_LABEL[b] }))} />
            <PrimaryButton onClick={() => void done()}>Done editing</PrimaryButton>
          </div>
        </div>
        <p className="edit-hint" role="status">
          Editing the {BP_LABEL[bp].toLowerCase()} layout of {draft.name}. Drag by the handle, resize from the corner. {others.join(' and ')} layouts are untouched.
          {saver.saving ? ' Saving…' : ''}
        </p>
        {saver.error ? (
          <div className="warn-box" role="alert">
            {saver.error}
          </div>
        ) : null}
        <div className="edit-canvas">
          <div className="edit-canvas__frame" style={preview ? { maxWidth: preview } : undefined}>
            {draft.widgets.length > 0 ? (
              <DashboardGrid dashboard={draft} breakpoint={bp} editing selectedId={selected} onSelect={setSelected} onLayoutChange={setLayout} />
            ) : (
              <div className="edit-canvas__empty">Add a widget to start.</div>
            )}
          </div>
        </div>
      </div>
      <aside className="edit-panel" aria-label="Widget settings and path browser">
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'nowrap' }}>
          <FormField label="Add widget">
            {(id) => (
              <select id={id} className="select" value={addType} onChange={(e) => setAddType(e.target.value as WidgetType)}>
                {WIDGET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {WIDGETS[t].title}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <Button onClick={addWidget}>Add</Button>
        </div>
        {widget ? (
          <WidgetSettings key={widget.id} widget={widget} onChange={updateWidget} onRemove={() => removeWidget(widget.id)} />
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <h2 className="panel-title">Dashboard</h2>
            <FormField label="Name">
              {(id) => (
                <input
                  id={id}
                  className="input"
                  value={name}
                  maxLength={40}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (e.target.value.trim()) edit({ ...draft, name: e.target.value.trim() });
                  }}
                />
              )}
            </FormField>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Select a widget on the canvas to change its settings.
            </p>
            <Button danger onClick={() => void deleteDashboard()}>
              Delete dashboard
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}
