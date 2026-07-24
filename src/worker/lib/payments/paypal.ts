// PayPal adapter — REQUEST-side / redirect (PAYMENT track).
//
// createPayment: converts VND→USD at order-creation time (rate from env), calls
// PayPal's Orders v2 create API, and returns a REDIRECT intent carrying the
// `approve` link. The customer approves there; we capture on return / webhook.
//
// verifyWebhook: PayPal signs webhooks. Production verification calls
// /v1/notifications/verify-webhook-signature with the transmission headers +
// the webhook id. We implement that call; if PAYPAL_WEBHOOK_ID is unset we fail
// closed (never trust an unverifiable money event).
//
// parseEvent: PayPal sends CHECKOUT.ORDER.APPROVED and
// PAYMENT.CAPTURE.COMPLETED. We normalize:
//   - orderRef      ← purchase_units[].custom_id / invoice_id (we set = orderRef)
//   - status        ← 'paid' on CAPTURE.COMPLETED / COMPLETED capture status
//   - amountVnd     ← recovered from custom_id-adjacent data is unreliable, so
//                     the webhook path re-reads amount from OUR payment row;
//                     here we surface the USD amount converted back is lossy,
//                     therefore amountVnd is carried as 0 and the route trusts
//                     the stored row. (SePay carries the real VND; PayPal's
//                     authoritative VND is our DB.) See route wrong-amount note.
//   - providerTxnId ← capture id (or order id as fallback)

import type {
  CreatePaymentInput,
  NormalizedPaymentEvent,
  PaymentEnv,
  PaymentIntent,
  PaymentProvider,
  WebhookVerification,
} from './types.ts'

const DEFAULT_BASE = 'https://api-m.sandbox.paypal.com'

/**
 * VND→USD conversion. Rate = VND per 1 USD (e.g. 25000). Rounds to 2 decimals
 * (PayPal requires exactly 2 for USD). Pure + exported so it is unit-tested
 * directly — this is the one number the product owner said must be configurable.
 */
export function vndToUsd(amountVnd: number, vndPerUsd: number): string {
  if (!(vndPerUsd > 0)) throw new Error('PAYPAL_VND_PER_USD phải là số dương')
  const usd = amountVnd / vndPerUsd
  return usd.toFixed(2)
}

/** OAuth2 client-credentials token for the PayPal REST API. */
async function fetchAccessToken(base: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`PayPal token error ${res.status}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('PayPal token missing access_token')
  return body.access_token
}

/** A PayPal order create response (only the bits we use). */
interface PaypalOrderResponse {
  id: string
  links?: Array<{ href: string; rel: string }>
}

export function createPaypalProvider(env: PaymentEnv): PaymentProvider {
  const base = env.PAYPAL_BASE_URL ?? DEFAULT_BASE
  const clientId = env.PAYPAL_CLIENT_ID ?? ''
  const secret = env.PAYPAL_SECRET ?? ''
  const vndPerUsd = Number(env.PAYPAL_VND_PER_USD ?? '0')
  const webhookId = env.PAYPAL_WEBHOOK_ID ?? ''

  return {
    id: 'paypal',

    async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
      const usd = vndToUsd(input.amountVnd, vndPerUsd)
      const token = await fetchAccessToken(base, clientId, secret)

      const res = await fetch(`${base}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              // custom_id + invoice_id both carry OUR order ref so the webhook
              // can tie the event back to our payment row.
              custom_id: input.orderRef,
              invoice_id: input.orderRef,
              description: input.description,
              amount: { currency_code: 'USD', value: usd },
            },
          ],
        }),
      })
      if (!res.ok) throw new Error(`PayPal create-order error ${res.status}`)
      const order = (await res.json()) as PaypalOrderResponse
      const approve = order.links?.find((l) => l.rel === 'approve')?.href
      if (!approve) throw new Error('PayPal order missing approve link')

      return { kind: 'redirect', approveUrl: approve, providerOrderId: order.id }
    },

    async verifyWebhook(req: Request): Promise<WebhookVerification> {
      // Fail closed when we cannot verify.
      if (clientId === '' || secret === '' || webhookId === '') return { valid: false }

      let body: unknown
      let bodyText: string
      try {
        bodyText = await req.text()
        body = JSON.parse(bodyText)
      } catch {
        return { valid: false }
      }

      const h = (name: string) => req.headers.get(name) ?? ''
      const verifyPayload = {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: body,
      }

      try {
        const token = await fetchAccessToken(base, clientId, secret)
        const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(verifyPayload),
        })
        if (!res.ok) return { valid: false }
        const out = (await res.json()) as { verification_status?: string }
        if (out.verification_status !== 'SUCCESS') return { valid: false }
        return { valid: true, rawEvent: body }
      } catch {
        return { valid: false }
      }
    },

    parseEvent(rawEvent: unknown): NormalizedPaymentEvent {
      const event = rawEvent as {
        event_type?: string
        resource?: {
          id?: string
          status?: string
          custom_id?: string
          invoice_id?: string
          amount?: { value?: string; currency_code?: string }
          purchase_units?: Array<{ custom_id?: string; invoice_id?: string }>
          supplementary_data?: unknown
        }
      }
      const r = event.resource ?? {}
      const orderRef =
        r.custom_id ??
        r.invoice_id ??
        r.purchase_units?.[0]?.custom_id ??
        r.purchase_units?.[0]?.invoice_id ??
        ''

      const type = event.event_type ?? ''
      const captureOk = r.status === 'COMPLETED' || type === 'PAYMENT.CAPTURE.COMPLETED'
      const status: 'paid' | 'failed' =
        captureOk || type === 'CHECKOUT.ORDER.APPROVED' ? 'paid' : 'failed'

      // PayPal amounts are USD; the authoritative VND is our stored row. We
      // carry 0 here and let the route trust payments.amount_vnd. This is why
      // wrong-amount checks for PayPal compare against the stored VND, not this.
      return {
        orderRef,
        status,
        amountVnd: 0,
        providerTxnId: String(r.id ?? ''),
        raw: rawEvent,
      }
    },
  }
}
