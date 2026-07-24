// D1 access for the payment path (PAYMENT track).
//
// ============================================================================
// IDEMPOTENCY — the money surface, guarded IN SQL (same discipline as bookings)
// ============================================================================
// SePay retries its webhook up to 7 times (Fibonacci schedule) until it gets
// HTTP 200 + {"success":true} within 30s. So `markPaid` MUST be safe to call
// many times for the same event and credit exactly ONCE.
//
// The guard is a SQL predicate on the UPDATE itself, not a JS read-then-write
// (which cannot be made atomic across an `await` — see the header of
// src/worker/db/bookings.ts). We flip the row with:
//
//   UPDATE payments SET status='paid', ... WHERE order_ref=? AND status='pending'
//
// `meta.changes` is 1 for the FIRST landing (won) and 0 for every retry after
// (already 'paid' → predicate fails → no row touched). Marking the appointment
// paid is chained in the SAME batch and carries the same guard, so a retry
// never re-touches the appointment either. Never a double credit.
// ============================================================================

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired'

export interface PaymentRow {
  id: number
  order_ref: string
  provider: string
  provider_txn_id: string | null
  amount_vnd: number
  status: PaymentStatus
  appointment_id: number | null
  raw_json: string | null
  created_at: number
  paid_at: number | null
}

export interface CreatePaymentRowInput {
  order_ref: string
  provider: 'sepay' | 'paypal'
  amount_vnd: number
  appointment_id: number | null
  created_at: number
}

/**
 * Inserts a pending payment row. `order_ref` is UNIQUE, so a duplicate create
 * for the same ref is rejected by the DB rather than forking into two rows.
 */
export async function createPaymentRow(db: D1Database, input: CreatePaymentRowInput): Promise<PaymentRow> {
  const row = await db
    .prepare(
      `INSERT INTO payments (order_ref, provider, amount_vnd, status, appointment_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       RETURNING id, order_ref, provider, provider_txn_id, amount_vnd, status,
                 appointment_id, raw_json, created_at, paid_at`,
    )
    .bind(input.order_ref, input.provider, input.amount_vnd, input.appointment_id, input.created_at)
    .first<PaymentRow>()
  return row!
}

export async function getPaymentByOrderRef(db: D1Database, orderRef: string): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT id, order_ref, provider, provider_txn_id, amount_vnd, status,
              appointment_id, raw_json, created_at, paid_at
       FROM payments WHERE order_ref = ?`,
    )
    .bind(orderRef)
    .first<PaymentRow>()
}

export type MarkPaidResult =
  | { outcome: 'credited'; payment: PaymentRow }
  | { outcome: 'already_paid'; payment: PaymentRow }
  | { outcome: 'not_found' }
  | { outcome: 'amount_mismatch'; payment: PaymentRow }

export interface MarkPaidInput {
  orderRef: string
  providerTxnId: string
  /** The amount the provider says was paid. For SePay this is the real VND and
   *  is checked against the stored amount. For PayPal, pass the stored amount
   *  (its authoritative VND lives in our row), i.e. skip the check by matching. */
  amountVnd: number
  rawJson: string
  paidAt: number
}

/**
 * Idempotent credit. Flips a PENDING payment (and its appointment) to paid,
 * exactly once. Returns:
 *   - 'credited'       first landing won the guard (changes = 1)
 *   - 'already_paid'   a retry / duplicate — nothing changed, no double credit
 *   - 'not_found'      no payment row for this order_ref
 *   - 'amount_mismatch' the provider amount != our stored amount → NOT credited
 *
 * WRONG AMOUNT: if the reported amount does not equal the stored amount we do
 * NOT flip to paid. We leave the row pending and report the mismatch so the
 * webhook returns success (to stop retries of a value that will never match)
 * while the money is NOT counted as a valid payment for that booking.
 */
export async function markPaid(db: D1Database, input: MarkPaidInput): Promise<MarkPaidResult> {
  const existing = await getPaymentByOrderRef(db, input.orderRef)
  if (existing === null) return { outcome: 'not_found' }
  if (existing.status === 'paid') return { outcome: 'already_paid', payment: existing }

  // Amount guard. SePay passes the real transferred VND; a mismatch means the
  // customer under/over-paid or a spoofed value — do not credit THIS booking.
  if (input.amountVnd !== existing.amount_vnd) {
    return { outcome: 'amount_mismatch', payment: existing }
  }

  // The authoritative flip: guarded on status='pending' so only the first
  // landing wins. The appointment update is chained in the SAME batch and
  // guarded via the payment still being pending (a subquery), so a retry that
  // finds the payment already 'paid' cannot re-touch the appointment either.
  const res = await db.batch([
    db
      .prepare(
        `UPDATE payments
           SET status='paid', provider_txn_id=?, raw_json=?, paid_at=?
         WHERE order_ref=? AND status='pending'`,
      )
      .bind(input.providerTxnId, input.rawJson, input.paidAt, input.orderRef),
    // Mark the appointment paid ALONGSIDE the payment — never inside the
    // booking write path. Guarded on the appointment's OWN payment_status still
    // being 'pending', so it is independently idempotent: a retry finds it
    // already 'paid' and changes 0 rows. (Statements in a D1 batch run in
    // order, so we cannot re-read the payment's pre-flip state here; the
    // appointment's own guard is the correct, self-contained one.)
    db
      .prepare(
        `UPDATE appointments
           SET payment_status='paid'
         WHERE id = (SELECT appointment_id FROM payments WHERE order_ref = ?)
           AND payment_status = 'pending'`,
      )
      .bind(input.orderRef),
  ])
  const changes = res[0]!.meta.changes ?? 0
  const after = await getPaymentByOrderRef(db, input.orderRef)
  if (changes === 0) {
    // Lost the race to a concurrent retry that flipped it first.
    return { outcome: 'already_paid', payment: after! }
  }
  return { outcome: 'credited', payment: after! }
}

/** Marks a pending payment failed (e.g. PayPal DENIED). Idempotent. */
export async function markFailed(db: D1Database, orderRef: string, rawJson: string): Promise<void> {
  await db
    .prepare(`UPDATE payments SET status='failed', raw_json=? WHERE order_ref=? AND status='pending'`)
    .bind(rawJson, orderRef)
    .run()
}
