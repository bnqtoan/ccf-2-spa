import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migration0001 from '../../migrations/0001_init.sql?raw'
import migration0003 from '../../migrations/0003_payments.sql?raw'
import { createSepayProvider, extractOrderRefFromContent } from '../../src/worker/lib/payments/sepay.ts'
import { createPaypalProvider, vndToUsd } from '../../src/worker/lib/payments/paypal.ts'
import { getProvider, isProviderId } from '../../src/worker/lib/payments/registry.ts'
import type { PaymentEnv } from '../../src/worker/lib/payments/types.ts'

const db = env.DB

// vitest-pool-workers does not auto-apply migrations_dir, so we run them here.
// Comments stripped line-by-line before splitting on ';' (same pattern as
// tests/api/bookings.test.ts — a naive split would swallow statements after a
// leading comment block).
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

beforeAll(async () => {
  for (const stmt of splitStatements(migration0001)) await db.prepare(stmt).run()
  for (const stmt of splitStatements(migration0003)) await db.prepare(stmt).run()
})

async function wipe(): Promise<void> {
  for (const t of ['payments', 'booking_items', 'appointments', 'customers']) {
    await db.prepare(`DELETE FROM ${t}`).run()
  }
}

/** Seed a bare appointment (payment_status defaults 'at_spa'). Returns its id. */
async function seedAppointment(): Promise<number> {
  const cust = await db
    .prepare("INSERT INTO customers (name, phone) VALUES ('T', '0900000001') RETURNING id")
    .first<{ id: number }>()
  const appt = await db
    .prepare(
      `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
       VALUES (?, 1000, 2000, 'booked', 'online', 0) RETURNING id`,
    )
    .bind(cust!.id)
    .first<{ id: number }>()
  return appt!.id
}

// A test PaymentEnv. SePay key/account are set; PayPal creds are NOT (its
// network calls are not exercised here — we test its pure/normalization parts).
const TEST_ENV: PaymentEnv = {
  SEPAY_API_KEY: 'test-sepay-key',
  SEPAY_ACCOUNT_NUMBER: '0123456789',
  PAYPAL_VND_PER_USD: '25000',
  PAYPAL_WEBHOOK_ID: 'test-webhook-id',
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function get(path: string) {
  const res = await exports.default.fetch(`https://example.com${path}`)
  return { status: res.status, body: (await res.json()) as any }
}

// ===========================================================================
// Adapter normalization — BOTH providers → the SAME NormalizedPaymentEvent
// ===========================================================================
describe('adapter normalization — cả hai cổng đổ về cùng một shape', () => {
  it('SePay webhook JSON → NormalizedPaymentEvent', () => {
    const prov = createSepayProvider(TEST_ENV)
    const raw = {
      id: 92704,
      gateway: 'Vietcombank',
      transactionDate: '2023-03-25 14:02:37',
      accountNumber: '0123456789',
      code: 'CCF7XABCD',
      content: 'chuyen tien CCF7XABCD',
      transferType: 'in',
      transferAmount: 300000,
      referenceCode: 'MBVCB.abc',
    }
    const ev = prov.parseEvent(raw)
    expect(ev).toEqual({
      orderRef: 'CCF7XABCD',
      status: 'paid',
      amountVnd: 300000,
      providerTxnId: '92704',
      raw,
    })
  })

  it('PayPal capture event → NormalizedPaymentEvent (same shape keys)', () => {
    const prov = createPaypalProvider(TEST_ENV)
    const raw = {
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-123',
        status: 'COMPLETED',
        custom_id: 'CCF7XABCD',
        amount: { value: '12.00', currency_code: 'USD' },
      },
    }
    const ev = prov.parseEvent(raw)
    // Same KEYS as SePay's normalized event — core logic can't tell them apart.
    expect(Object.keys(ev).sort()).toEqual(
      ['amountVnd', 'orderRef', 'providerTxnId', 'raw', 'status'].sort(),
    )
    expect(ev.orderRef).toBe('CCF7XABCD')
    expect(ev.status).toBe('paid')
    expect(ev.providerTxnId).toBe('CAP-123')
  })

  it('SePay transferType "out" normalizes to failed (not a customer payment)', () => {
    const prov = createSepayProvider(TEST_ENV)
    const ev = prov.parseEvent({ id: 1, code: 'CCF1X', transferType: 'out', transferAmount: 5 })
    expect(ev.status).toBe('failed')
  })

  it('PayPal CHECKOUT.ORDER.APPROVED also normalizes to paid', () => {
    const prov = createPaypalProvider(TEST_ENV)
    const ev = prov.parseEvent({
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: 'ORD-9', purchase_units: [{ custom_id: 'CCF9X' }] },
    })
    expect(ev.status).toBe('paid')
    expect(ev.orderRef).toBe('CCF9X')
  })

  it('extractOrderRefFromContent pulls code from mangled bank content', () => {
    expect(extractOrderRefFromContent('CHUYEN TIEN CCF12XABCD abc')).toBe('CCF12XABCD')
    expect(extractOrderRefFromContent('no code here')).toBeNull()
    expect(extractOrderRefFromContent(null)).toBeNull()
  })
})

// ===========================================================================
// PayPal VND→USD conversion (the one configurable number)
// ===========================================================================
describe('PayPal VND→USD conversion', () => {
  it('converts at the configured rate, 2 decimals', () => {
    expect(vndToUsd(250000, 25000)).toBe('10.00')
    expect(vndToUsd(300000, 25000)).toBe('12.00')
    expect(vndToUsd(123456, 25000)).toBe('4.94') // 4.93824 → 4.94
  })
  it('rejects a non-positive rate', () => {
    expect(() => vndToUsd(1000, 0)).toThrow()
    expect(() => vndToUsd(1000, -5)).toThrow()
  })
})

// ===========================================================================
// Registry / factory
// ===========================================================================
describe('provider registry', () => {
  it('picks the right adapter by id, null for unknown', () => {
    expect(getProvider('sepay', TEST_ENV)!.id).toBe('sepay')
    expect(getProvider('paypal', TEST_ENV)!.id).toBe('paypal')
    expect(getProvider('nope', TEST_ENV)).toBeNull()
    expect(isProviderId('sepay')).toBe(true)
    expect(isProviderId('stripe')).toBe(false)
  })
})

// ===========================================================================
// SePay webhook auth (Apikey header)
// ===========================================================================
describe('SePay verifyWebhook — Apikey auth', () => {
  it('accepts the correct Apikey header', async () => {
    const prov = createSepayProvider(TEST_ENV)
    const req = new Request('https://x/webhook', {
      method: 'POST',
      headers: { authorization: 'Apikey test-sepay-key', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, code: 'CCF1X', transferType: 'in', transferAmount: 1 }),
    })
    const v = await prov.verifyWebhook(req)
    expect(v.valid).toBe(true)
  })
  it('rejects a wrong / missing Apikey', async () => {
    const prov = createSepayProvider(TEST_ENV)
    const bad = new Request('https://x/webhook', {
      method: 'POST',
      headers: { authorization: 'Apikey WRONG' },
      body: '{}',
    })
    expect((await prov.verifyWebhook(bad)).valid).toBe(false)
    const none = new Request('https://x/webhook', { method: 'POST', body: '{}' })
    expect((await prov.verifyWebhook(none)).valid).toBe(false)
  })
})

// ===========================================================================
// Route: POST /api/payments/create → discriminated intent
// ===========================================================================
describe('POST /api/payments/create', () => {
  beforeEach(wipe)

  it('SePay → creates pending row + returns a qr intent, appointment → pending', async () => {
    const apptId = await seedAppointment()
    const { status, body } = await post('/api/payments/create', {
      appointment_id: apptId,
      amount_vnd: 300000,
      provider: 'sepay',
    })
    expect(status).toBe(201)
    expect(body.intent.kind).toBe('qr')
    expect(body.intent.amountVnd).toBe(300000)
    expect(body.order_ref).toMatch(/^CCF/)

    const row = await db.prepare('SELECT * FROM payments WHERE order_ref = ?').bind(body.order_ref).first<any>()
    expect(row.status).toBe('pending')
    expect(row.amount_vnd).toBe(300000)
    const appt = await db.prepare('SELECT payment_status FROM appointments WHERE id = ?').bind(apptId).first<any>()
    expect(appt.payment_status).toBe('pending')
  })

  it('unknown appointment → 404', async () => {
    const { status, body } = await post('/api/payments/create', {
      appointment_id: 999999,
      amount_vnd: 100000,
      provider: 'sepay',
    })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('bad provider → 422 VALIDATION', async () => {
    const apptId = await seedAppointment()
    const { status, body } = await post('/api/payments/create', {
      appointment_id: apptId,
      amount_vnd: 100000,
      provider: 'stripe',
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})

// ===========================================================================
// Route: SePay webhook — the money surface
// ===========================================================================
async function startSepayPayment(amountVnd = 300000): Promise<{ apptId: number; orderRef: string }> {
  const apptId = await seedAppointment()
  const { body } = await post('/api/payments/create', {
    appointment_id: apptId,
    amount_vnd: amountVnd,
    provider: 'sepay',
  })
  return { apptId, orderRef: body.order_ref }
}

function sepayWebhookBody(orderRef: string, amount: number, txnId = 555) {
  return {
    id: txnId,
    gateway: 'Vietcombank',
    transactionDate: '2026-07-24 10:00:00',
    accountNumber: '0123456789',
    code: orderRef,
    content: `thanh toan ${orderRef}`,
    transferType: 'in',
    transferAmount: amount,
    referenceCode: 'REF1',
  }
}

describe('POST /api/payments/webhook/sepay — verify + idempotent credit', () => {
  beforeEach(wipe)

  it('valid webhook with matching code → credits once, flips appointment to paid', async () => {
    const { apptId, orderRef } = await startSepayPayment(300000)
    const { status, body } = await post(
      '/api/payments/webhook/sepay',
      sepayWebhookBody(orderRef, 300000),
      { authorization: 'Apikey test-sepay-key' },
    )
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.credited).toBe(true)

    const row = await db.prepare('SELECT * FROM payments WHERE order_ref = ?').bind(orderRef).first<any>()
    expect(row.status).toBe('paid')
    expect(row.provider_txn_id).toBe('555')
    expect(row.paid_at).not.toBeNull()
    const appt = await db.prepare('SELECT payment_status FROM appointments WHERE id = ?').bind(apptId).first<any>()
    expect(appt.payment_status).toBe('paid')
  })

  it('DUPLICATE webhook (SePay retry) → credited only once, no double effect', async () => {
    const { orderRef } = await startSepayPayment(300000)
    const headers = { authorization: 'Apikey test-sepay-key' }
    const first = await post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), headers)
    const second = await post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), headers)
    const third = await post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), headers)

    expect(first.body.credited).toBe(true)
    expect(second.body.credited).toBe(false)
    expect(second.body.outcome).toBe('already_paid')
    expect(third.body.credited).toBe(false)
    // Exactly one paid row, still one appointment paid.
    const paidCount = await db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE order_ref = ? AND status='paid'")
      .bind(orderRef)
      .first<{ n: number }>()
    expect(paidCount!.n).toBe(1)
  })

  it('CONCURRENT duplicate webhooks → still exactly one credit', async () => {
    const { orderRef } = await startSepayPayment(300000)
    const headers = { authorization: 'Apikey test-sepay-key' }
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), headers)),
    )
    const credited = results.filter((r) => r.body.credited === true)
    expect(credited).toHaveLength(1)
    const row = await db.prepare("SELECT status FROM payments WHERE order_ref = ?").bind(orderRef).first<any>()
    expect(row.status).toBe('paid')
  })

  it('WRONG amount → not credited, appointment stays pending', async () => {
    const { apptId, orderRef } = await startSepayPayment(300000)
    const { status, body } = await post(
      '/api/payments/webhook/sepay',
      sepayWebhookBody(orderRef, 50000), // underpaid
      { authorization: 'Apikey test-sepay-key' },
    )
    expect(status).toBe(200) // still 200 so SePay stops retrying a wrong value
    expect(body.credited).toBe(false)
    expect(body.outcome).toBe('amount_mismatch')

    const row = await db.prepare('SELECT status FROM payments WHERE order_ref = ?').bind(orderRef).first<any>()
    expect(row.status).toBe('pending')
    const appt = await db.prepare('SELECT payment_status FROM appointments WHERE id = ?').bind(apptId).first<any>()
    expect(appt.payment_status).toBe('pending')
  })

  it('unauthenticated webhook → 401, nothing credited', async () => {
    const { orderRef } = await startSepayPayment(300000)
    const { status } = await post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), {
      authorization: 'Apikey WRONG',
    })
    expect(status).toBe(401)
    const row = await db.prepare('SELECT status FROM payments WHERE order_ref = ?').bind(orderRef).first<any>()
    expect(row.status).toBe('pending')
  })

  it('webhook for an unknown order_ref → success:true, matched:false, nothing crashes', async () => {
    const { status, body } = await post(
      '/api/payments/webhook/sepay',
      sepayWebhookBody('CCFDOESNOTEXIST', 300000),
      { authorization: 'Apikey test-sepay-key' },
    )
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.matched).toBe(false)
  })
})

// ===========================================================================
// Route: GET /api/payments/:orderRef — the customer's status poll
// ===========================================================================
describe('GET /api/payments/:orderRef', () => {
  beforeEach(wipe)

  it('returns status without leaking secrets; flips to paid after webhook', async () => {
    const { orderRef } = await startSepayPayment(300000)
    let s = await get(`/api/payments/${orderRef}`)
    expect(s.status).toBe(200)
    expect(s.body.status).toBe('pending')
    expect(s.body).not.toHaveProperty('raw_json')

    await post('/api/payments/webhook/sepay', sepayWebhookBody(orderRef, 300000), {
      authorization: 'Apikey test-sepay-key',
    })
    s = await get(`/api/payments/${orderRef}`)
    expect(s.body.status).toBe('paid')
  })

  it('unknown order_ref → 404', async () => {
    const { status } = await get('/api/payments/CCFNOPE')
    expect(status).toBe(404)
  })
})
