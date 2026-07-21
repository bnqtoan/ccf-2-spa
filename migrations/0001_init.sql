-- 0001_init.sql — PRD §3.2 core schema
--
-- Timestamps are UTC epoch seconds (INTEGER). Exception: work_shifts.start_min/
-- end_min are minutes-from-local-midnight (0..1440) — see CONVENTIONS §1.
--
-- FKs use ON DELETE RESTRICT: history rows are never orphaned by a delete.
-- Rows are never deleted for business state either (cancel = status update);
-- RESTRICT here is a last-resort guard against accidental hard deletes.

CREATE TABLE skills (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE staff (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  phone  TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE staff_skills (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  PRIMARY KEY (staff_id, skill_id)
);

CREATE INDEX idx_staff_skills_skill_id ON staff_skills(skill_id);

CREATE TABLE services (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  skill_id  INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  body_zone TEXT NOT NULL CHECK (body_zone IN ('hair','hands','feet','face','body')),
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE service_variants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id       INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  duration_min     INTEGER NOT NULL,
  buffer_after_min INTEGER NOT NULL DEFAULT 0,
  price            INTEGER NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE work_shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,
  CHECK (start_min < end_min)
);

CREATE INDEX idx_work_shifts_staff_weekday ON work_shifts(staff_id, weekday);

CREATE TABLE time_off (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  start_at INTEGER NOT NULL,
  end_at   INTEGER NOT NULL,
  reason   TEXT
);

CREATE INDEX idx_time_off_staff_start ON time_off(staff_id, start_at);

CREATE TABLE customers (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  phone TEXT
);

CREATE INDEX idx_customers_phone ON customers(phone);

CREATE TABLE appointments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  start_at    INTEGER NOT NULL,
  end_at      INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('booked','in_service','done','cancelled','no_show')),
  source      TEXT NOT NULL CHECK (source IN ('online','walk_in','admin')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_appointments_start_at ON appointments(start_at);

CREATE TABLE booking_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  staff_id       INTEGER NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  variant_id     INTEGER NOT NULL REFERENCES service_variants(id) ON DELETE RESTRICT,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER NOT NULL,
  block_end_at   INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('booked','in_service','done','cancelled','no_show')),
  cancelled_at   INTEGER
);

CREATE INDEX idx_booking_items_staff_start ON booking_items(staff_id, start_at);
CREATE INDEX idx_booking_items_appointment_id ON booking_items(appointment_id);
