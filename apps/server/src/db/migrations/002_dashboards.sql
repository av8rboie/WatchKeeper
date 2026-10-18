-- M2: dashboards and thresholds. Additions only.

-- added: widget order within a dashboard. Phone layouts and auto-placement
-- follow it.
ALTER TABLE widget ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
CREATE INDEX widget_dashboard ON widget(dashboard_id, sort);

-- added: one threshold per path, so widget settings and the thresholds list
-- edit the same limits.
CREATE UNIQUE INDEX threshold_path ON threshold(path);
