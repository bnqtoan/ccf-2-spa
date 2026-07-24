// GET /api/admin/staff/:id/upcoming-items — the read that powers G0's
// BLOCK-before-deactivate guard. Verifies it returns live future bookings and
// excludes what does not strand a customer (past, done, cancelled).

import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'

const db = env.DB

function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const index = line.indexOf('--')
      return index === -1 ? line : line.slice(0, index)
    })
    .join('\n')
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

beforeAll(async () => {
  for (const statement of splitStatements(migrationSql)) {
    await db.prepare(statement).run()
  }
})

beforeEach(async () => {
  for (const table of ['booking_items', 'appointments', 'customers', 'time_off', 'work_shifts', 'service_variants', 'services', 'staff_skills', 'staff', 'skills']) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }
})

async function api(path: string): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`)
}

async function seedBaseline(): Promise<{ staffId: number; variantId: number; customerId: number }> {
  const skill = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind('Massage').first<{ id: number }>()
  const staff = await db.prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id').bind('Lan').first<{ id: number }>()
  await db.prepare('INSERT INTO staff_skills (staff_id, skill_id) VALUES (?, ?)').bind(staff!.id, skill!.id).run()
  const svc = await db.prepare("INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, 'body', 1) RETURNING id").bind('Body', skill!.id).first<{ id: number }>()
  const variant = await db.prepare('INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active) VALUES (?, ?, 30, 5, 100000, 1) RETURNING id').bind(svc!.id, '30p').first<{ id: number }>()
  const customer = await db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id').bind('Khách', '0900000000').first<{ id: number }>()
  return { staffId: staff!.id, variantId: variant!.id, customerId: customer!.id }
}

async function insertItem(
  base: { staffId: number; variantId: number; customerId: number },
  opts: { startAt: number; status: string },
): Promise<number> {
  const appt = await db
    .prepare(
      "INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at) VALUES (?, ?, ?, 'booked', 'online', ?) RETURNING id",
    )
    .bind(base.customerId, opts.startAt, opts.startAt + 1800, Math.floor(Date.now() / 1000))
    .first<{ id: number }>()
  const item = await db
    .prepare(
      'INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    )
    .bind(appt!.id, base.staffId, base.variantId, opts.startAt, opts.startAt + 1800, opts.startAt + 2100, opts.status)
    .first<{ id: number }>()
  return item!.id
}

describe('GET /api/admin/staff/:id/upcoming-items', () => {
  it('trả về lịch booked sắp tới của đúng nhân viên', async () => {
    const base = await seedBaseline()
    const future = Math.floor(Date.now() / 1000) + 3600
    const itemId = await insertItem(base, { startAt: future, status: 'booked' })

    const res = await api(`/api/admin/staff/${base.staffId}/upcoming-items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { item_id: number; customer_name: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.item_id).toBe(itemId)
    expect(body.items[0]!.customer_name).toBe('Khách')
  })

  it('loại lịch đã qua, đã xong, đã huỷ — chỉ giữ lịch còn giữ khách', async () => {
    const base = await seedBaseline()
    const now = Math.floor(Date.now() / 1000)
    await insertItem(base, { startAt: now - 7200, status: 'done' }) // đã xong quá khứ
    await insertItem(base, { startAt: now - 7200, status: 'booked' }) // đã trôi qua
    await insertItem(base, { startAt: now + 3600, status: 'cancelled' }) // đã huỷ
    const live = await insertItem(base, { startAt: now + 3600, status: 'booked' }) // còn giữ

    const body = (await api(`/api/admin/staff/${base.staffId}/upcoming-items`).then((r) => r.json())) as {
      items: { item_id: number }[]
    }
    expect(body.items.map((i) => i.item_id)).toEqual([live])
  })

  it('nhân viên không có lịch sắp tới trả về rỗng (cho ngưng làm an toàn)', async () => {
    const base = await seedBaseline()
    const body = (await api(`/api/admin/staff/${base.staffId}/upcoming-items`).then((r) => r.json())) as {
      items: unknown[]
    }
    expect(body.items).toEqual([])
  })

  it('nhân viên không tồn tại trả về 404', async () => {
    const res = await api('/api/admin/staff/999999/upcoming-items')
    expect(res.status).toBe(404)
  })
})
