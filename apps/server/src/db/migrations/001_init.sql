-- Starting schema from the build spec. Additions beyond the spec are marked
-- "added" and are permitted by it (new tables, columns and indexes only).

-- users and settings
-- id is the Home Assistant user id from the ingress headers. pin_hash is ''
-- for users without a helm PIN.
CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('skipper','crew','guest')),
  pin_hash TEXT NOT NULL, unit_prefs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  mapped INTEGER NOT NULL DEFAULT 0,        -- added: role set by the skipper
  last_seen TEXT,                           -- added: last request through ingress
  failed_pins INTEGER NOT NULL DEFAULT 0,   -- added: PIN lockout
  locked_until TEXT                          -- added: PIN lockout
);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- added: PIN elevations. A guest device elevates to act as a crew member
-- for 12 h. id is the SHA-256 of the cookie token; the elevation only holds
-- for the HA user who entered the PIN.
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ha_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX session_user ON session(user_id);

-- dashboards
CREATE TABLE dashboard (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL,
  layouts TEXT NOT NULL,           -- JSON: { phone: [...], tablet: [...], desktop: [...] }
  updated_at TEXT NOT NULL
);
CREATE TABLE widget (
  id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
  type TEXT NOT NULL, label TEXT, path TEXT, config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE threshold (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, label TEXT NOT NULL,
  warn_low REAL, warn_high REAL, alarm_low REAL, alarm_high REAL,   -- SI units
  enabled INTEGER NOT NULL DEFAULT 1
);

-- history (downsampled)
CREATE TABLE sample_1s  (path TEXT NOT NULL, ts INTEGER NOT NULL, value REAL, PRIMARY KEY (path, ts)) WITHOUT ROWID;
CREATE TABLE sample_1m  (path TEXT NOT NULL, ts INTEGER NOT NULL, avg REAL, min REAL, max REAL, PRIMARY KEY (path, ts)) WITHOUT ROWID;
CREATE TABLE sample_10m (path TEXT NOT NULL, ts INTEGER NOT NULL, avg REAL, min REAL, max REAL, PRIMARY KEY (path, ts)) WITHOUT ROWID;
CREATE INDEX sample_1s_ts ON sample_1s(ts);    -- added: retention and rollup scans
CREATE INDEX sample_1m_ts ON sample_1m(ts);    -- added
CREATE TABLE connection_gap (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT);

-- logbook
CREATE TABLE passage (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, from_place TEXT, to_place TEXT,
  skipper_id TEXT REFERENCES user(id), crew TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE log_entry (
  id TEXT PRIMARY KEY, passage_id TEXT REFERENCES passage(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hourly','event','manual','anchor','checklist','system')),
  event_type TEXT,                 -- e.g. engine_start, pressure_drop, reef_in
  snapshot TEXT NOT NULL,          -- JSON of raw SI values, null for stale or missing
  crew_fields TEXT NOT NULL DEFAULT '{}',  -- sea state, sky, sail plan, watch keeper
  remarks TEXT, created_by TEXT REFERENCES user(id),
  signed_by TEXT REFERENCES user(id), signed_at TEXT
);
CREATE TABLE log_amendment (
  id TEXT PRIMARY KEY, log_entry_id TEXT NOT NULL REFERENCES log_entry(id),
  field TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id), ts TEXT NOT NULL
);
CREATE TRIGGER log_entry_snapshot_immutable BEFORE UPDATE OF snapshot, ts, kind, crew_fields, remarks ON log_entry
BEGIN SELECT RAISE(ABORT, 'log entries are append-only; use log_amendment'); END;
CREATE TRIGGER log_entry_no_delete BEFORE DELETE ON log_entry
BEGIN SELECT RAISE(ABORT, 'log entries cannot be deleted'); END;

-- maintenance
CREATE TABLE equipment (
  id TEXT PRIMARY KEY, system TEXT NOT NULL, name TEXT NOT NULL,
  make TEXT, model TEXT, serial TEXT, location TEXT, supplier TEXT,
  installed_on TEXT, warranty_until TEXT,
  meter_path TEXT,                 -- e.g. propulsion.port.runTime
  notes TEXT, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE maintenance_task (
  id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL REFERENCES equipment(id),
  title TEXT NOT NULL,
  every_hours REAL, every_days INTEGER, every_nm REAL, due_on TEXT,   -- any combination; whichever comes first
  soon_hours REAL DEFAULT 25, soon_days INTEGER DEFAULT 30,
  last_done_at TEXT, last_done_hours REAL, last_done_nm REAL,
  template_id TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE maintenance_record (
  id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL REFERENCES equipment(id),
  task_id TEXT REFERENCES maintenance_task(id),   -- null for ad-hoc repairs
  done_at TEXT NOT NULL, meter_hours REAL, user_id TEXT REFERENCES user(id),
  notes TEXT, cost_cents INTEGER
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, part_number TEXT,
  qty_aboard REAL NOT NULL DEFAULT 0, min_qty REAL NOT NULL DEFAULT 0,
  unit TEXT, location TEXT, supplier TEXT
);
CREATE TABLE task_part (task_id TEXT REFERENCES maintenance_task(id), part_id TEXT REFERENCES part(id), qty REAL NOT NULL, PRIMARY KEY (task_id, part_id));
CREATE TABLE record_part (record_id TEXT REFERENCES maintenance_record(id), part_id TEXT REFERENCES part(id), qty REAL NOT NULL, PRIMARY KEY (record_id, part_id));

-- shared
CREATE TABLE attachment (
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
  file_path TEXT NOT NULL, mime TEXT NOT NULL, caption TEXT, created_at TEXT NOT NULL
);
CREATE TABLE checklist (id TEXT PRIMARY KEY, name TEXT NOT NULL, items TEXT NOT NULL, writes_log INTEGER NOT NULL DEFAULT 1);
CREATE TABLE checklist_run (
  id TEXT PRIMARY KEY, checklist_id TEXT NOT NULL REFERENCES checklist(id),
  started_at TEXT NOT NULL, finished_at TEXT, user_id TEXT REFERENCES user(id),
  results TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE anchor_set (
  id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL,
  rode_m REAL, radius_m REAL NOT NULL, depth_m REAL,
  set_at TEXT NOT NULL, lifted_at TEXT
);
