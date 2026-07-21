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

async function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, init)
}

async function post(path: string, body: unknown): Promise<Response> {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function patch(path: string, body: unknown): Promise<Response> {
  return api(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function createBase() {
  const skill = await (await post('/api/admin/skills', { name: 'Massage' })).json() as { id: number }
  const staff = await (await post('/api/admin/staff', { name: 'Lan' })).json() as { id: number }
  await post(`/api/admin/staff/${staff.id}/skills`, { skill_id: skill.id })
  const service = await (await post('/api/admin/services', { name: 'Massage body', skill_id: skill.id, body_zone: 'body' })).json() as { id: number }
  const variant = await (await post('/api/admin/variants', { service_id: service.id, name: '60 phút', duration_min: 60, buffer_after_min: 10, price: 300000 })).json() as { id: number }
  return { skill, staff, service, variant }
}

describe('admin CRUD', () => {
  it('tạo skill mới thành công và xuất hiện trong danh sách liệt kê', async () => {
    const created = await post('/api/admin/skills', { name: 'Mi' })
    expect(created.status).toBe(201)
    const skill = await created.json() as { id: number; name: string }
    const list = await (await api('/api/admin/skills')).json() as { id: number; name: string }[]
    expect(list).toContainEqual(skill)
  })

  it('tạo staff mới thành công với active mặc định true', async () => {
    const response = await post('/api/admin/staff', { name: 'Hoa', phone: '0901' })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ name: 'Hoa', phone: '0901', active: 1 })
  })

  it('sửa tên staff qua PATCH cập nhật đúng bản ghi, không đụng bản ghi khác', async () => {
    const first = await (await post('/api/admin/staff', { name: 'A' })).json() as { id: number }
    const second = await (await post('/api/admin/staff', { name: 'B' })).json() as { id: number }
    expect((await patch(`/api/admin/staff/${first.id}`, { name: 'A mới' })).status).toBe(200)
    const list = await (await api('/api/admin/staff')).json() as { id: number; name: string }[]
    expect(list.find((staff) => staff.id === first.id)?.name).toBe('A mới')
    expect(list.find((staff) => staff.id === second.id)?.name).toBe('B')
  })

  it('liệt kê service trả kèm đúng skill_id và body_zone đã lưu', async () => {
    const { skill, service } = await createBase()
    const list = await (await api('/api/admin/services')).json() as { id: number; skill_id: number; body_zone: string }[]
    expect(list).toContainEqual(expect.objectContaining({ id: service.id, skill_id: skill.id, body_zone: 'body' }))
  })

  it('tạo variant mới gắn đúng vào service_id đã chỉ định', async () => {
    const { service } = await createBase()
    const response = await post('/api/admin/variants', { service_id: service.id, name: '90 phút', duration_min: 90, buffer_after_min: 15, price: 450000 })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ service_id: service.id, name: '90 phút' })
  })

  it('sửa work_shift đổi đúng start_min/end_min của ca đó', async () => {
    const { staff } = await createBase()
    const shift = await (await post('/api/admin/shifts', { staff_id: staff.id, weekday: 1, start_min: 540, end_min: 1140 })).json() as { id: number }
    const response = await patch(`/api/admin/shifts/${shift.id}`, { start_min: 600, end_min: 1080 })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: shift.id, start_min: 600, end_min: 1080 })
  })

  it('vô hiệu hoá staff (active=false) khiến KTV đó không còn xuất hiện trong kết quả availability của bất kỳ ngày nào', async () => {
    const { staff, variant } = await createBase()
    const date = '2099-07-21'
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    await post('/api/admin/shifts', { staff_id: staff.id, weekday, start_min: 540, end_min: 1140 })
    const before = await (await api(`/api/availability?variant_id=${variant.id}&date=${date}`)).json() as { slots: { staff_ids: number[] }[] }
    expect(before.slots.some((slot) => slot.staff_ids.includes(staff.id))).toBe(true)
    expect((await patch(`/api/admin/staff/${staff.id}`, { active: false })).status).toBe(200)
    const after = await (await api(`/api/availability?variant_id=${variant.id}&date=${date}`)).json() as { slots: { staff_ids: number[] }[] }
    expect(after.slots.some((slot) => slot.staff_ids.includes(staff.id))).toBe(false)
  })

  it('xoá một skill không còn service nào dùng thành công', async () => {
    const skill = await (await post('/api/admin/skills', { name: 'Unused' })).json() as { id: number }
    expect((await api(`/api/admin/skills/${skill.id}`, { method: 'DELETE' })).status).toBe(204)
    const list = await (await api('/api/admin/skills')).json() as { id: number }[]
    expect(list.map((item) => item.id)).not.toContain(skill.id)
  })

  it('xoá một skill đang được service tham chiếu bị chặn, trả lỗi rõ ràng thay vì lỗi SQL thô', async () => {
    const { skill } = await createBase()
    const response = await api(`/api/admin/skills/${skill.id}`, { method: 'DELETE' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { code: 'VALIDATION', message: 'cannot delete a skill used by services' } })
  })

  it.each([0, -1])('tạo variant với duration_min = %i trả 422 VALIDATION', async (duration_min) => {
    const { service } = await createBase()
    const response = await post('/api/admin/variants', { service_id: service.id, name: 'Sai', duration_min, buffer_after_min: 0, price: 1 })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('tạo shift với start_min >= end_min bị chặn, trả 422 VALIDATION', async () => {
    const { staff } = await createBase()
    const response = await post('/api/admin/shifts', { staff_id: staff.id, weekday: 1, start_min: 600, end_min: 600 })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('gán một skill cho staff thành công, staff đó xuất hiện trong ứng viên availability cho service dùng skill đó', async () => {
    const skill = await (await post('/api/admin/skills', { name: 'Da mặt' })).json() as { id: number }
    const staff = await (await post('/api/admin/staff', { name: 'Yến' })).json() as { id: number }
    const service = await (await post('/api/admin/services', { name: 'Facial', skill_id: skill.id, body_zone: 'face' })).json() as { id: number }
    const variant = await (await post('/api/admin/variants', { service_id: service.id, name: 'Cơ bản', duration_min: 45, buffer_after_min: 5, price: 200000 })).json() as { id: number }
    const date = '2099-07-21'
    await post('/api/admin/shifts', { staff_id: staff.id, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), start_min: 540, end_min: 1140 })
    await post(`/api/admin/staff/${staff.id}/skills`, { skill_id: skill.id })
    const available = await (await api(`/api/availability?variant_id=${variant.id}&date=${date}`)).json() as { slots: { staff_ids: number[] }[] }
    expect(available.slots.some((slot) => slot.staff_ids.includes(staff.id))).toBe(true)
  })

  it('bỏ gán skill khỏi staff thành công, staff đó không còn là ứng viên cho service dùng skill đó nữa', async () => {
    const { skill, staff, variant } = await createBase()
    const date = '2099-07-21'
    await post('/api/admin/shifts', { staff_id: staff.id, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), start_min: 540, end_min: 1140 })
    expect((await api(`/api/admin/staff/${staff.id}/skills/${skill.id}`, { method: 'DELETE' })).status).toBe(204)
    const available = await (await api(`/api/availability?variant_id=${variant.id}&date=${date}`)).json() as { slots: { staff_ids: number[] }[] }
    expect(available.slots.some((slot) => slot.staff_ids.includes(staff.id))).toBe(false)
  })

  it('sửa staff không tồn tại trả 404 NOT_FOUND', async () => {
    const response = await patch('/api/admin/staff/99999', { name: 'Không có' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('tạo service thiếu tên trả 422 VALIDATION', async () => {
    const skill = await (await post('/api/admin/skills', { name: 'Massage' })).json() as { id: number }
    const response = await post('/api/admin/services', { skill_id: skill.id, body_zone: 'body' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('vô hiệu hoá service (active=false) không xoá variant của nó, chỉ ẩn khỏi danh sách active', async () => {
    const { service, variant } = await createBase()
    const response = await patch(`/api/admin/services/${service.id}`, { active: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: service.id, active: 0 })
    const stillThere = await db.prepare('SELECT id FROM service_variants WHERE id = ?').bind(variant.id).first<{ id: number }>()
    expect(stillThere?.id).toBe(variant.id)
  })
})
