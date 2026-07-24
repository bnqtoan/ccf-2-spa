-- 0002_commission_tax.sql — R2 payroll/measurement (Track C).
--
-- ADDITIVE ONLY: two ALTER TABLE ADD COLUMN with defaults, so this applies
-- cleanly on top of 0001 without touching any existing row's meaning. No
-- existing column is modified, no table is dropped.
--
-- WHY these two columns:
--   staff.commission_rate — payroll = staff revenue (status='done') × rate.
--     Stored as a fraction 0..1 (0.30 = 30%). Default 0 so an un-configured
--     staff earns 0 commission rather than a surprise number — the safe/visible
--     default (owner must opt in per staff).
--   shop_settings.tax_rate — a single shop-wide reference tax rate applied to
--     total revenue. Deliberately MINIMAL: this is a reference figure for the
--     owner, NOT VN e-invoice compliance (out of scope per the card).
--
-- shop_settings is a singleton table (one row, id=1). A table (not a column on
-- some existing row) keeps a shop-wide scalar from being duplicated per-staff.

ALTER TABLE staff ADD COLUMN commission_rate REAL NOT NULL DEFAULT 0;

CREATE TABLE shop_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  tax_rate REAL NOT NULL DEFAULT 0
);

INSERT INTO shop_settings (id, tax_rate) VALUES (1, 0);
