-- M3 logbook.

-- Distance-run total when the passage started, for "distance since departure".
ALTER TABLE passage ADD COLUMN start_distance_m REAL;
-- At most one active passage.
CREATE UNIQUE INDEX passage_one_active ON passage (coalesce(ended_at, 'active')) WHERE ended_at IS NULL;

-- One hourly entry per hour, whatever the scheduler does.
CREATE UNIQUE INDEX log_entry_hourly_ts ON log_entry (ts) WHERE kind = 'hourly';
CREATE INDEX log_entry_ts ON log_entry (ts);
CREATE INDEX log_entry_passage_ts ON log_entry (passage_id, ts);
CREATE INDEX log_amendment_entry ON log_amendment (log_entry_id, ts);
CREATE INDEX attachment_owner ON attachment (owner_type, owner_id);

-- Signing is the only update an entry gets, and only once.
CREATE TRIGGER log_entry_sign_once BEFORE UPDATE OF signed_by, signed_at ON log_entry
WHEN OLD.signed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'log entry is already signed'); END;
CREATE TRIGGER log_entry_passage_fixed BEFORE UPDATE OF passage_id, event_type, created_by ON log_entry
BEGIN SELECT RAISE(ABORT, 'log entries are append-only; use log_amendment'); END;

-- Amendments are the correction record: never edited or removed.
CREATE TRIGGER log_amendment_immutable BEFORE UPDATE ON log_amendment
BEGIN SELECT RAISE(ABORT, 'amendments cannot be changed'); END;
CREATE TRIGGER log_amendment_no_delete BEFORE DELETE ON log_amendment
BEGIN SELECT RAISE(ABORT, 'amendments cannot be deleted'); END;
