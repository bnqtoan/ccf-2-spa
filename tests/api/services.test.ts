import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'

const db = env.DB

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
  for (const stmt of splitStatements(migrationSql)) {
    await db.prepare(stmt).run()
  }
})

async function wipe(): Promise<void> {
  for (const t of [
    'booking_items',
    'appointments',
    'customers',
    'time_off',
    'work_shifts',
    'service_variants',
    'services',
    'staff_skills',
    'staff',
    'skills',
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run()
  }
}

async function insertSkill(name: string): Promise<number> {
  const r = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>()
  return r!.id
}

async function insertService(
  name: string,
  skillId: number,
  opts: { zone?: string; active?: number } = {},
): Promise<number> {
  const r = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(name, skillId, opts.zone ?? 'body', opts.active ?? 1)
    .first<{ id: number }>()
  return r!.id
}

async function insertVariant(
  serviceId: number,
  opts: { name: string; duration: number; buffer: number; price: number; active?: number },
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(serviceId, opts.name, opts.duration, opts.buffer, opts.price, opts.active ?? 1)
    .first<{ id: number }>()
  return r!.id
}

async function getServices(): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/services')
  return { status: res.status, body: await res.json() }
}

describe('GET /api/services', () => {
  beforeEach(wipe)

  it('trả danh sách service kèm variant lồng bên trong', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage thư giãn', skill)
    await insertVariant(svc, { name: '45 phút', duration: 45, buffer: 10, price: 250000 })

    const { status, body } = await getServices()
    expect(status).toBe(200)
    expect(body.services).toHaveLength(1)
    expect(body.services[0].name).toBe('Massage thư giãn')
    expect(body.services[0].variants).toHaveLength(1)
    expect(body.services[0].variants[0]).toMatchObject({
      name: '45 phút',
      duration_min: 45,
      buffer_after_min: 10,
      price: 250000,
    })
  })

  it('service đã vô hiệu hoá (active=0) không xuất hiện', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage cũ', skill, { active: 0 })
    await insertVariant(svc, { name: '45 phút', duration: 45, buffer: 10, price: 250000 })

    const { body } = await getServices()
    expect(body.services).toHaveLength(0)
  })

  it('variant đã vô hiệu hoá không xuất hiện trong service còn active', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage thư giãn', skill)
    await insertVariant(svc, { name: '30 phút', duration: 30, buffer: 5, price: 200000 })
    await insertVariant(svc, { name: '90 phút cũ', duration: 90, buffer: 15, price: 400000, active: 0 })

    const { body } = await getServices()
    expect(body.services).toHaveLength(1)
    expect(body.services[0].variants).toHaveLength(1)
    expect(body.services[0].variants[0].name).toBe('30 phút')
  })

  it('service không còn variant active nào thì không xuất hiện', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage hết bán', skill)
    await insertVariant(svc, { name: '45 phút', duration: 45, buffer: 10, price: 250000, active: 0 })

    const { body } = await getServices()
    expect(body.services).toHaveLength(0)
  })

  it('variant sắp xếp theo duration_min tăng dần', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage thư giãn', skill)
    await insertVariant(svc, { name: '90 phút', duration: 90, buffer: 15, price: 400000 })
    await insertVariant(svc, { name: '30 phút', duration: 30, buffer: 5, price: 200000 })
    await insertVariant(svc, { name: '60 phút', duration: 60, buffer: 10, price: 300000 })

    const { body } = await getServices()
    const durations = body.services[0].variants.map((v: any) => v.duration_min)
    expect(durations).toEqual([30, 60, 90])
  })

  it('service sắp xếp theo id tăng dần (tất định qua nhiều lần gọi)', async () => {
    const skill = await insertSkill('Massage')
    const svcB = await insertService('B Service', skill)
    await insertVariant(svcB, { name: '30 phút', duration: 30, buffer: 5, price: 200000 })
    const svcA = await insertService('A Service', skill)
    await insertVariant(svcA, { name: '30 phút', duration: 30, buffer: 5, price: 200000 })

    const first = await getServices()
    const second = await getServices()
    const idsFirst = first.body.services.map((s: any) => s.id)
    const idsSecond = second.body.services.map((s: any) => s.id)
    expect(idsFirst).toEqual([svcB, svcA].sort((a, b) => a - b))
    expect(idsSecond).toEqual(idsFirst)
  })

  it('DB rỗng trả mảng services rỗng chứ không phải lỗi', async () => {
    const { status, body } = await getServices()
    expect(status).toBe(200)
    expect(body.services).toEqual([])
  })

  it('response không lộ cột active hay skill_id', async () => {
    const skill = await insertSkill('Massage')
    const svc = await insertService('Massage thư giãn', skill)
    await insertVariant(svc, { name: '45 phút', duration: 45, buffer: 10, price: 250000 })

    const { body } = await getServices()
    const service = body.services[0]
    expect(service.active).toBeUndefined()
    expect(service.skill_id).toBeUndefined()
    expect(service.variants[0].active).toBeUndefined()
    expect(service.variants[0].skill_id).toBeUndefined()
  })
})
