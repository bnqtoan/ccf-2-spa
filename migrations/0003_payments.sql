-- 0003_payments.sql — online payment at booking time (PAYMENT track).
--
-- ADDITIVE ONLY: one new table + two indexes. No existing table is altered,
-- no column is dropped, so this applies cleanly on top of 0002 and every
-- current row keeps its meaning. "Trả tại spa" (pay at spa) stays the default
-- path — this table only exists for the ONLINE-payment mode, which is opt-in
-- per booking.
--
-- WHY a table (not columns on appointments):
--   A payment is its own lifecycle object (pending → paid/failed/expired) with
--   a provider identity (SePay txn id / PayPal order id) that has no meaning on
--   the appointment row. Keeping it separate means the booking write path
--   (insertBookingAtomically) is NOT touched — payment lives ALONGSIDE the
--   appointment, so the atomic booking guarantee is preserved.
--
-- IDEMPOTENCY (the money surface): SePay retries a webhook up to 7 times on a
-- Fibonacci schedule until it gets HTTP 200 + {"success":true} within 30s.
-- The webhook handler flips status with an UPDATE ... WHERE status = 'pending'
-- guard (see src/worker/db/payments.ts), so the FIRST landing wins and every
-- retry after it changes 0 rows — never a double credit. This mirrors the
-- SQL-guard race-proofing already used in src/worker/db/bookings.ts.
--
-- order_ref: the app-generated code embedded in the transfer content (SePay)
-- and used as PayPal's custom_id / invoice reference. UNIQUE so a provider
-- retry or a duplicate create can never fork into two rows.
--
-- amount_vnd: price is ALWAYS stored in VND (the shop's currency). PayPal's
-- USD conversion happens only at PayPal-order-creation time using a configured
-- rate; the VND figure here stays the source of truth for reconciliation.
--
-- appointment_id: nullable FK. A payment row is created together with (or just
-- after) the appointment; it stays nullable so a payment intent can exist a
-- beat before the appointment id is known and so the column can never block
-- the payments insert.

CREATE TABLE payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref       TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL CHECK (provider IN ('sepay','paypal')),
  provider_txn_id TEXT,
  amount_vnd      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','failed','expired')),
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE RESTRICT,
  raw_json        TEXT,
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER
);

CREATE INDEX idx_payments_appointment_id ON payments(appointment_id);
CREATE INDEX idx_payments_status ON payments(status);

-- appointments.payment_status — the appointment's OWN view of payment, so the
-- timeline/lookup can show "chờ thanh toán" vs "đã thanh toán" vs "trả tại spa"
-- without joining payments every time.
--   'at_spa'  — default; the existing "trả tại spa" path. Every pre-existing
--               row and every pay-at-spa booking is this. Chosen as DEFAULT so
--               0003 does not change the meaning of any current appointment.
--   'pending' — an online payment was started, money not yet confirmed.
--   'paid'    — the webhook confirmed money landed.
-- ADDITIVE: one ADD COLUMN with a default, no existing row rewritten.
ALTER TABLE appointments
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'at_spa'
  CHECK (payment_status IN ('at_spa','pending','paid'));
