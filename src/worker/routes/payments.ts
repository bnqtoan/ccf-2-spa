// Payment routes (PAYMENT track). Behind /api/payments/* so main stays
// deployable even before secrets are set.
//
//   POST /api/payments/create        — start a payment for an appointment.
//     Body: { appointment_id, amount_vnd, provider, description? }
//     → creates a pending payment row + calls the adapter → returns the
//       DISCRIMINATED PaymentIntent (qr for SePay, redirect for PayPal).
//
//   POST /api/payments/webhook/:provider — PUBLIC. Verify (adapter) → parse →
//     normalized event → idempotent credit → mark appointment paid. Returns
//     { success: true } with 200 so SePay stops retrying. This is a money
//     surface: verification is STRICT and we fail closed.
//
// Core logic here only ever speaks NormalizedPaymentEvent — never a SePay or
// PayPal field. All provider specifics live inside the adapters.

import { Hono } from 'hono'
import {
  createPaymentRow,
  getPaymentByOrderRef,
  markFailed,
  markPaid,
} from '../db/payments.ts'
import { getProvider, isProviderId } from '../lib/payments/registry.ts'
import type { PaymentEnv } from '../lib/payments/types.ts'
import { serverNow } from '../lib/clock.ts'

type Bindings = { DB: D1Database } & PaymentEnv

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** App order code embedded in the transfer content / PayPal invoice. Prefix
 *  CCF keeps it recognizable in a bank statement and matchable from free-text
 *  content when SePay's parsed `code` is null. */
export function makeOrderRef(appointmentId: number, now: number): string {
  // CCF + appointment id + short time-based suffix. Uppercase alphanumeric so
  // it survives banks that strip punctuation/lowercase in transfer content.
  const suffix = now.toString(36).toUpperCase().slice(-4)
  return `CCF${appointmentId}X${suffix}`
}

interface CreateBody {
  appointment_id?: unknown
  amount_vnd?: unknown
  provider?: unknown
  description?: unknown
}

routes.post('/api/payments/create', async (c) => {
  const db = c.env.DB

  let payload: CreateBody
  try {
    payload = (await c.req.json()) as CreateBody
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const appointmentId = Number(payload.appointment_id)
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return c.json(errorBody('VALIDATION', 'appointment_id phải là số nguyên dương'), 422)
  }
  const amountVnd = Number(payload.amount_vnd)
  if (!Number.isInteger(amountVnd) || amountVnd <= 0) {
    return c.json(errorBody('VALIDATION', 'amount_vnd phải là số nguyên dương (VND)'), 422)
  }
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  if (!isProviderId(provider)) {
    return c.json(errorBody('VALIDATION', 'provider phải là "sepay" hoặc "paypal"'), 422)
  }
  const description =
    typeof payload.description === 'string' && payload.description.trim() !== ''
      ? payload.description.trim()
      : `Thanh toán lịch #${appointmentId}`

  // The appointment must exist and belong to an online-payment flow. We flip it
  // to payment_status='pending' here (it was inserted as 'at_spa' by the
  // booking path; choosing "pay online" moves it to pending).
  const appt = await db
    .prepare('SELECT id, payment_status FROM appointments WHERE id = ?')
    .bind(appointmentId)
    .first<{ id: number; payment_status: string }>()
  if (appt === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy lịch hẹn ${appointmentId}`), 404)
  }
  if (appt.payment_status === 'paid') {
    return c.json(errorBody('ALREADY_PAID', 'Lịch hẹn này đã được thanh toán'), 409)
  }

  const now = serverNow(c)
  const orderRef = makeOrderRef(appointmentId, now)

  const prov = getProvider(provider, c.env)
  if (prov === null) {
    return c.json(errorBody('VALIDATION', 'Cổng thanh toán không hợp lệ'), 422)
  }

  // 1) create the pending row (order_ref UNIQUE guards duplicate creates).
  try {
    await createPaymentRow(db, {
      order_ref: orderRef,
      provider,
      amount_vnd: amountVnd,
      appointment_id: appointmentId,
      created_at: now,
    })
  } catch {
    return c.json(errorBody('CONFLICT', 'Không tạo được yêu cầu thanh toán, vui lòng thử lại'), 409)
  }

  // 2) move the appointment into the pending-payment state.
  await db
    .prepare(`UPDATE appointments SET payment_status='pending' WHERE id = ? AND payment_status='at_spa'`)
    .bind(appointmentId)
    .run()

  // 3) ask the adapter to build the intent (QR or redirect).
  let intent
  try {
    intent = await prov.createPayment({ orderRef, amountVnd, description })
  } catch {
    // Never leak a raw gateway error to the customer.
    return c.json(
      errorBody('PROVIDER_ERROR', 'Chưa kết nối được cổng thanh toán. Bạn thử lại hoặc chọn trả tại spa.'),
      502,
    )
  }

  return c.json({ order_ref: orderRef, provider, intent }, 201)
})

// Public webhook. `:provider` picks the adapter. Verification is strict; we
// fail closed. We always try to return { success: true } on a VERIFIED event
// so SePay stops its retry schedule.
routes.post('/api/payments/webhook/:provider', async (c) => {
  const db = c.env.DB
  const providerId = c.req.param('provider')
  if (!isProviderId(providerId)) {
    return c.json(errorBody('NOT_FOUND', 'Cổng thanh toán không hợp lệ'), 404)
  }
  const prov = getProvider(providerId, c.env)!

  // 1) verify (adapter owns the auth: SePay Apikey header / PayPal signature).
  const verification = await prov.verifyWebhook(c.req.raw)
  if (!verification.valid) {
    // 401 with no body detail — a spoofed/unauthenticated call learns nothing.
    return c.json(errorBody('UNAUTHORIZED', 'Xác thực webhook thất bại'), 401)
  }

  // 2) normalize — from here core logic never sees provider specifics.
  const event = prov.parseEvent(verification.rawEvent)
  if (event.orderRef === '') {
    // Verified but unmatchable (no order code) — accept so the provider stops
    // retrying, but do nothing. Nothing to credit.
    return c.json({ success: true, matched: false })
  }

  const rawJson = JSON.stringify(event.raw)

  if (event.status === 'failed') {
    await markFailed(db, event.orderRef, rawJson)
    return c.json({ success: true, matched: true, credited: false })
  }

  // 3) idempotent credit. For PayPal the authoritative VND is our stored row,
  // so we pass the stored amount (skip the SePay-style amount check by matching
  // it); for SePay we pass the real transferred VND and the check is enforced.
  let amountToCredit = event.amountVnd
  if (providerId === 'paypal') {
    const existing = await getPaymentByOrderRef(db, event.orderRef)
    amountToCredit = existing ? existing.amount_vnd : event.amountVnd
  }

  const result = await markPaid(db, {
    orderRef: event.orderRef,
    providerTxnId: event.providerTxnId,
    amountVnd: amountToCredit,
    rawJson,
    paidAt: serverNow(c),
  })

  // Always 200 + success on a verified event so retries stop. `credited`
  // distinguishes the first landing from a retry; `outcome` aids debugging.
  const httpBody: Record<string, unknown> = {
    success: true,
    matched: result.outcome !== 'not_found',
    credited: result.outcome === 'credited',
    outcome: result.outcome,
  }
  return c.json(httpBody)
})

// Small helper for the customer's "did my payment land yet?" poll and for the
// e2e verification. GET /api/payments/:orderRef → status only (no secrets).
routes.get('/api/payments/:orderRef', async (c) => {
  const orderRef = c.req.param('orderRef')
  const row = await getPaymentByOrderRef(c.env.DB, orderRef)
  if (row === null) return c.json(errorBody('NOT_FOUND', 'Không tìm thấy giao dịch'), 404)
  return c.json({
    order_ref: row.order_ref,
    provider: row.provider,
    status: row.status,
    amount_vnd: row.amount_vnd,
    appointment_id: row.appointment_id,
    paid_at: row.paid_at,
  })
})

export default routes
