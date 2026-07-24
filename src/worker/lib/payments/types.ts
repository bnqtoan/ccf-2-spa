// Payment abstraction — the shared shapes ALL providers speak (PAYMENT track).
//
// ============================================================================
// WHY AN ADAPTER PATTERN — SePay and PayPal are OPPOSITE-shaped
// ============================================================================
// SePay is RECEIVE-side (VietQR). The app generates an order code, renders a
// QR (bank account + amount + code in the transfer content), then WAITS. There
// is NO hosted checkout URL to send the customer to. Money landing in the bank
// triggers a SePay webhook, matched back to us by the code inside the transfer
// `content`.
//
// PayPal is REQUEST-side (redirect). The app calls PayPal to CREATE an order,
// gets back an approve URL, and sends the customer THERE to approve; the app
// then captures. Confirmation is a webhook and/or the capture response.
//
// So one produces a QR to display and one produces a URL to redirect to. If we
// pretended they were the same shape, the UI would have to guess. Instead the
// `PaymentIntent` union is DISCRIMINATED by `kind`, and the UI switches on it.
//
// Both webhooks, however, MUST normalize down to ONE shape —
// `NormalizedPaymentEvent` — so the core "mark this order paid" logic never
// speaks SePay or PayPal specifics. That is the whole point: the differences
// live ONLY inside the two adapters; everything downstream is provider-blind.
// ============================================================================

export type ProviderId = 'sepay' | 'paypal'

/** Input every provider's createPayment receives. Amount is always VND. */
export interface CreatePaymentInput {
  /** App-generated order code. Embedded in SePay transfer content; PayPal
   *  custom_id / invoice ref. UNIQUE per payment row. */
  orderRef: string
  amountVnd: number
  description: string
}

/**
 * The DISCRIMINATED result of createPayment. The UI switches on `kind`:
 *   - 'qr'       → SePay: render a VietQR and wait for the webhook.
 *   - 'redirect' → PayPal: send the customer to `approveUrl`, then capture.
 * These are deliberately NOT collapsed into one shape.
 */
export type PaymentIntent =
  | {
      kind: 'qr'
      /** Raw VietQR payload string (EMVCo) if the provider returns one. */
      qrData: string | null
      /** A ready-to-<img> QR image URL (SePay renders one for us). */
      qrImageUrl: string | null
      /** The order code the customer must include in the transfer content. */
      code: string
      /** Destination bank account the customer transfers to. */
      accountNumber: string
      amountVnd: number
    }
  | {
      kind: 'redirect'
      /** Where to send the customer to approve the payment. */
      approveUrl: string
      /** The provider's own order id (PayPal order id). */
      providerOrderId: string
    }

/**
 * The ONE shape both webhooks normalize to. Core logic only ever sees this —
 * never a SePay field, never a PayPal field.
 */
export interface NormalizedPaymentEvent {
  /** Ties the event back to OUR payment row (payments.order_ref). */
  orderRef: string
  status: 'paid' | 'failed'
  amountVnd: number
  /** The provider's transaction id (SePay `id` / PayPal capture id). */
  providerTxnId: string
  /** The untouched provider event, stored for audit (payments.raw_json). */
  raw: unknown
}

/** Result of verifying an inbound webhook request. */
export interface WebhookVerification {
  valid: boolean
  /** The parsed provider event when valid; undefined when not. */
  rawEvent?: unknown
}

/**
 * The interface every adapter implements. Two opposite-shaped providers, one
 * contract. Note `verifyWebhook` takes the raw Request (headers matter for
 * auth on both providers) and `parseEvent` turns a VERIFIED provider event
 * into the normalized shape.
 */
export interface PaymentProvider {
  readonly id: ProviderId
  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>
  verifyWebhook(req: Request): Promise<WebhookVerification>
  parseEvent(rawEvent: unknown): NormalizedPaymentEvent
}

/** The env values the adapters read. Kept narrow so tests can construct it. */
export interface PaymentEnv {
  SEPAY_API_KEY?: string
  SEPAY_ACCOUNT_NUMBER?: string
  PAYPAL_CLIENT_ID?: string
  PAYPAL_SECRET?: string
  PAYPAL_BASE_URL?: string
  PAYPAL_VND_PER_USD?: string
  PAYPAL_WEBHOOK_ID?: string
}
