import { Card } from '../shell/components';

/** Screens not built yet. Each names the milestone that delivers it. */
export function Placeholder({ title, milestone, what }: { title: string; milestone?: string; what: string }) {
  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">{title}</h1>
      </div>
      <Card>
        <p style={{ margin: 0 }}>{what}</p>
        {milestone ? <p className="muted" style={{ margin: '8px 0 0' }}>Arrives in milestone {milestone}.</p> : null}
      </Card>
    </>
  );
}
