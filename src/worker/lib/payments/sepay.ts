// SePay adapter — RECEIVE-side / VietQR (PAYMENT track).
//
// createPayment: builds a QR intent. We do NOT call SePay to "create an order"
// — SePay is receive-side. We render a VietQR (via img.vietqr.io, the same
// renderer SePay's docs use) pointing at OUR bank account, for the exact
// amount, with the order code inside the transfer CONTENT. The customer scans,
// transfers, and we WAIT.
//
// verifyWebhook: SePay authenticates its webhook with a fixed header
//   Authorization: Apikey <SEPAY_API_KEY>
// We compare it to our configured key. No body signature — the shared key IS
// the auth, so the check must be exact and constant-ish (mismatch → invalid,
// no event surfaced).
//
// parseEvent: SePay's JSON has fields { id, gateway, transactionDate,
// accountNumber, code, content, transferType('in'/'out'), description,
// transferAmount, accumulated, referenceCode }. We normalize:
//   - orderRef      ← code (falls back to extracting from content)
//   - status        ← 'paid' when transferType === 'in', else 'failed'
//   - amountVnd     ← transferAmount
//   - providerTxnId ← String(id)  (SePay's unique txn id → idempotency key)

import type {
  CreatePaymentInput,
  NormalizedPaymentEvent,
  PaymentEnv,
  PaymentIntent,
  PaymentProvider,
  WebhookVerification,
} from './types.ts'

/** The raw SePay webhook body shape (documented fields). */
export interface SepayWebhookEvent {
  id: number | string
  gateway?: string
  transactionDate?: string
  accountNumber?: string
  code?: string | null
  content?: string
  transferType?: 'in' | 'out'
  description?: string
  transferAmount?: number
  accumulated?: number
  referenceCode?: string
}

/**
 * Pull an order code out of a free-text transfer content when SePay's parsed
 * `code` field is null (banks mangle content differently). We look for our
 * prefix `CCF` followed by alphanumerics. Kept simple and total.
 */
export function extractOrderRefFromContent(content: string | undefined | null): string | null {
  if (!content) return null
  const m = content.toUpperCase().match(/CCF[A-Z0-9]+/)
  return m ? m[0] : null
}

export function createSepayProvider(env: PaymentEnv): PaymentProvider {
  const account = env.SEPAY_ACCOUNT_NUMBER ?? ''
  const apiKey = env.SEPAY_API_KEY ?? ''

  return {
    id: 'sepay',

    async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
      // VietQR image renderer: account + amount + content (the order code).
      // We do NOT hit SePay's API here — nothing to create server-side; the QR
      // simply encodes a bank transfer the customer initiates.
      const params = new URLSearchParams({
        amount: String(input.amountVnd),
        addInfo: input.orderRef,
      })
      const qrImageUrl = account
        ? `https://qr.sepay.vn/img?acc=${encodeURIComponent(account)}&template=compact&${params.toString()}`
        : null

      return {
        kind: 'qr',
        qrData: null,
        qrImageUrl,
        code: input.orderRef,
        accountNumber: account,
        amountVnd: input.amountVnd,
      }
    },

    async verifyWebhook(req: Request): Promise<WebhookVerification> {
      const auth = req.headers.get('authorization') ?? ''
      // Expected: "Apikey <key>". Reject anything else, and reject when no key
      // is configured (fail closed on a money surface).
      const expected = `Apikey ${apiKey}`
      if (apiKey === '' || auth !== expected) {
        return { valid: false }
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return { valid: false }
      }
      return { valid: true, rawEvent: body }
    },

    parseEvent(rawEvent: unknown): NormalizedPaymentEvent {
      const e = rawEvent as SepayWebhookEvent
      const orderRef = (e.code && e.code.trim() !== '' ? e.code : extractOrderRefFromContent(e.content)) ?? ''
      // Money IN = paid; an 'out' movement is not a customer payment.
      const status: 'paid' | 'failed' = e.transferType === 'in' ? 'paid' : 'failed'
      return {
        orderRef,
        status,
        amountVnd: Number(e.transferAmount ?? 0),
        providerTxnId: String(e.id),
        raw: rawEvent,
      }
    },
  }
}
