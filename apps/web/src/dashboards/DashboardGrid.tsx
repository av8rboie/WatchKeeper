import { memo, useMemo } from 'react';
import GridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { BREAKPOINT_COLS, GRID_ROW_PX, type Breakpoint, type Dashboard, type LayoutItem, type Widget } from '@watchkeeper/shared';
import { WIDGETS } from './widgets';

const GAP: Record<Breakpoint, number> = { phone: 8, tablet: 12, desktop: 16 };

function GripIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** Widgets re-render on their own live values, not on every layout change around them. */
const WidgetBody = memo(function WidgetBody({ widget }: { widget: Widget }) {
  const def = WIDGETS[widget.type];
  return def ? <def.Component widget={widget} /> : null;
});

const sameLayout = (a: LayoutItem[], b: LayoutItem[]) =>
  a.length === b.length && a.every((it) => b.some((l) => l.i === it.i && l.x === it.x && l.y === it.y && l.w === it.w && l.h === it.h));

/**
 * One breakpoint's layout of a dashboard. View mode is locked: no drag, no
 * resize. Edit mode shows a drag handle and a resize corner on every widget.
 */
export function DashboardGrid(props: {
  dashboard: Dashboard;
  breakpoint: Breakpoint;
  editing?: boolean;
  selectedId?: string | null;
  onSelect?(id: string): void;
  onLayoutChange?(layout: LayoutItem[]): void;
}) {
  const { dashboard, breakpoint: bp, editing = false } = props;
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const layout = dashboard.layouts[bp];
  const byId = useMemo(() => new Map(dashboard.widgets.map((w) => [w.id, w])), [dashboard.widgets]);
  const handleChange = (next: Layout) => {
    if (!editing || !props.onLayoutChange) return;
    const items: LayoutItem[] = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    if (!sameLayout(items, layout)) props.onLayoutChange(items);
  };

  return (
    // React 18's ref type predates nullable RefObjects; the hook's ref is a plain object ref.
    <div ref={containerRef as React.RefObject<HTMLDivElement>} className={`dash-grid dash-grid--${bp} ${editing ? 'dash-grid--editing' : ''}`} data-breakpoint={bp}>
      {mounted ? (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: BREAKPOINT_COLS[bp], rowHeight: GRID_ROW_PX, margin: [GAP[bp], GAP[bp]], containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: '.widget-frame__handle', bounded: false, threshold: 3 }}
          resizeConfig={{ enabled: editing, handles: ['se'] }}
          onLayoutChange={handleChange}
        >
          {layout.map((item) => {
            const w = byId.get(item.i);
            if (!w) return <div key={item.i} />;
            const selected = editing && props.selectedId === w.id;
            const label = w.label ?? WIDGETS[w.type]?.title ?? w.type;
            return (
              <div key={w.id} className={`widget-frame ${selected ? 'widget-frame--selected' : ''}`} data-widget-id={w.id} data-widget-type={w.type}>
                <WidgetBody widget={w} />
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="widget-frame__select"
                      aria-pressed={selected}
                      aria-label={`Edit ${label}`}
                      onClick={() => props.onSelect?.(w.id)}
                    />
                    <span className="widget-frame__handle" aria-hidden="true" title="Drag to move">
                      <GripIcon />
                    </span>
                  </>
                ) : null}
              </div>
            );
          })}
        </GridLayout>
      ) : null}
    </div>
  );
}
