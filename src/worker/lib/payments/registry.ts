// Provider registry — pick a PaymentProvider by id (PAYMENT track).
//
// The rest of the app never imports sepay.ts / paypal.ts directly; it asks the
// registry for a provider by id and then speaks only the PaymentProvider
// interface. Adding a third gateway = one case here + one adapter file.

import { createPaypalProvider } from './paypal.ts'
import { createSepayProvider } from './sepay.ts'
import type { PaymentEnv, PaymentProvider, ProviderId } from './types.ts'

export function isProviderId(x: string): x is ProviderId {
  return x === 'sepay' || x === 'paypal'
}

/** Returns the adapter for `id`, or null for an unknown provider. */
export function getProvider(id: string, env: PaymentEnv): PaymentProvider | null {
  switch (id) {
    case 'sepay':
      return createSepayProvider(env)
    case 'paypal':
      return createPaypalProvider(env)
    default:
      return null
  }
}
