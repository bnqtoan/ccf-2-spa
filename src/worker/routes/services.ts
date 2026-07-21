// GET /api/services — public catalog for the booking widget (PRD §9, §3.2).
//
// Distinct from GET /api/admin/services (admin-crud.ts): the public endpoint
// only shows what a customer can actually book — active services WITH at
// least one active variant, variants nested inside, no admin-only columns
// (`skill_id`, `active`) leaked. A service that lost every active variant
// disappears entirely rather than rendering a dead-end pick with nothing
// selectable underneath it.
//
// One join, grouped in JS — never N+1 (CONVENTIONS §7 / card's known trap).

import { Hono } from 'hono'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

interface ServiceVariantRow {
  service_id: number
  service_name: string
  body_zone: string
  variant_id: number
  variant_name: string
  duration_min: number
  buffer_after_min: number
  price: number
}

routes.get('/api/services', async (c) => {
  const db = c.env.DB

  // Both `active` filters matter: a service that itself is active but whose
  // only variants are disabled must not appear (card's known trap).
  const res = await db
    .prepare(
      `SELECT s.id AS service_id, s.name AS service_name, s.body_zone AS body_zone,
              sv.id AS variant_id, sv.name AS variant_name,
              sv.duration_min AS duration_min, sv.buffer_after_min AS buffer_after_min,
              sv.price AS price
       FROM services s
       JOIN service_variants sv ON sv.service_id = s.id
       WHERE s.active = 1 AND sv.active = 1
       ORDER BY s.id, sv.duration_min`,
    )
    .all<ServiceVariantRow>()

  // Deterministic order (card): service by id, variant by duration_min — both
  // already guaranteed by ORDER BY above; a Map preserves first-insertion
  // order for keys, so grouping does not need a second sort.
  const byService = new Map<
    number,
    { id: number; name: string; body_zone: string; variants: unknown[] }
  >()

  for (const row of res.results) {
    let entry = byService.get(row.service_id)
    if (entry === undefined) {
      entry = { id: row.service_id, name: row.service_name, body_zone: row.body_zone, variants: [] }
      byService.set(row.service_id, entry)
    }
    entry.variants.push({
      id: row.variant_id,
      name: row.variant_name,
      duration_min: row.duration_min,
      buffer_after_min: row.buffer_after_min,
      price: row.price,
    })
  }

  return c.json({ services: [...byService.values()] })
})

export default routes
