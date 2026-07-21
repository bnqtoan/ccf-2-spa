import type { BodyZone, Service, ServiceVariant, Skill, Staff, WorkShift } from './types'

export type StaffPatch = Partial<Pick<Staff, 'name' | 'phone' | 'active'>>
export type ServicePatch = Partial<Pick<Service, 'name' | 'skill_id' | 'body_zone' | 'active'>>
export type VariantPatch = Partial<Pick<ServiceVariant, 'service_id' | 'name' | 'duration_min' | 'buffer_after_min' | 'price' | 'active'>>
export type ShiftPatch = Partial<Pick<WorkShift, 'staff_id' | 'weekday' | 'start_min' | 'end_min'>>

export async function listSkills(db: D1Database): Promise<Skill[]> {
  const result = await db.prepare('SELECT id, name FROM skills ORDER BY id').all<Skill>()
  return result.results
}

export async function createSkill(db: D1Database, name: string): Promise<Skill> {
  return (await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id, name').bind(name).first<Skill>())!
}

export async function updateSkill(db: D1Database, id: number, name: string): Promise<Skill | null> {
  await db.prepare('UPDATE skills SET name = ? WHERE id = ?').bind(name, id).run()
  return db.prepare('SELECT id, name FROM skills WHERE id = ?').bind(id).first<Skill>()
}

export async function deleteSkillIfUnused(db: D1Database, id: number): Promise<'deleted' | 'in_use' | 'not_found'> {
  const skill = await db.prepare('SELECT id FROM skills WHERE id = ?').bind(id).first<{ id: number }>()
  if (!skill) return 'not_found'
  const used = await db.prepare('SELECT 1 FROM services WHERE skill_id = ? LIMIT 1').bind(id).first()
  if (used) return 'in_use'
  await db.prepare('DELETE FROM skills WHERE id = ?').bind(id).run()
  return 'deleted'
}

export async function listStaff(db: D1Database): Promise<Staff[]> {
  const result = await db.prepare('SELECT id, name, phone, active FROM staff ORDER BY id').all<Staff>()
  return result.results
}

export async function createStaff(db: D1Database, name: string, phone: string | null): Promise<Staff> {
  return (await db
    .prepare('INSERT INTO staff (name, phone) VALUES (?, ?) RETURNING id, name, phone, active')
    .bind(name, phone)
    .first<Staff>())!
}

export async function updateStaff(db: D1Database, id: number, patch: StaffPatch): Promise<Staff | null> {
  const current = await db.prepare('SELECT id, name, phone, active FROM staff WHERE id = ?').bind(id).first<Staff>()
  if (!current) return null
  const next = { ...current, ...patch }
  await db.prepare('UPDATE staff SET name = ?, phone = ?, active = ? WHERE id = ?').bind(next.name, next.phone, next.active, id).run()
  return { ...next, id }
}

export async function assignSkillToStaff(db: D1Database, staffId: number, skillId: number): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO staff_skills (staff_id, skill_id) VALUES (?, ?)').bind(staffId, skillId).run()
}

export async function unassignSkillFromStaff(db: D1Database, staffId: number, skillId: number): Promise<boolean> {
  const existing = await db
    .prepare('SELECT 1 FROM staff_skills WHERE staff_id = ? AND skill_id = ?')
    .bind(staffId, skillId)
    .first()
  if (!existing) return false
  await db.prepare('DELETE FROM staff_skills WHERE staff_id = ? AND skill_id = ?').bind(staffId, skillId).run()
  return true
}

export async function listServices(db: D1Database): Promise<Service[]> {
  const result = await db.prepare('SELECT id, name, skill_id, body_zone, active FROM services ORDER BY id').all<Service>()
  return result.results
}

export async function createService(db: D1Database, name: string, skillId: number, bodyZone: BodyZone): Promise<Service> {
  return (await db
    .prepare('INSERT INTO services (name, skill_id, body_zone) VALUES (?, ?, ?) RETURNING id, name, skill_id, body_zone, active')
    .bind(name, skillId, bodyZone)
    .first<Service>())!
}

export async function updateService(db: D1Database, id: number, patch: ServicePatch): Promise<Service | null> {
  const current = await db.prepare('SELECT id, name, skill_id, body_zone, active FROM services WHERE id = ?').bind(id).first<Service>()
  if (!current) return null
  const next = { ...current, ...patch }
  await db
    .prepare('UPDATE services SET name = ?, skill_id = ?, body_zone = ?, active = ? WHERE id = ?')
    .bind(next.name, next.skill_id, next.body_zone, next.active, id)
    .run()
  return { ...next, id }
}

export async function listVariants(db: D1Database): Promise<ServiceVariant[]> {
  const result = await db
    .prepare('SELECT id, service_id, name, duration_min, buffer_after_min, price, active FROM service_variants ORDER BY id')
    .all<ServiceVariant>()
  return result.results
}

export async function createVariant(
  db: D1Database,
  serviceId: number,
  name: string,
  durationMin: number,
  bufferAfterMin: number,
  price: number,
): Promise<ServiceVariant> {
  return (await db
    .prepare(
      'INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price) VALUES (?, ?, ?, ?, ?) RETURNING id, service_id, name, duration_min, buffer_after_min, price, active',
    )
    .bind(serviceId, name, durationMin, bufferAfterMin, price)
    .first<ServiceVariant>())!
}

export async function updateVariant(db: D1Database, id: number, patch: VariantPatch): Promise<ServiceVariant | null> {
  const current = await db
    .prepare('SELECT id, service_id, name, duration_min, buffer_after_min, price, active FROM service_variants WHERE id = ?')
    .bind(id)
    .first<ServiceVariant>()
  if (!current) return null
  const next = { ...current, ...patch }
  await db
    .prepare('UPDATE service_variants SET service_id = ?, name = ?, duration_min = ?, buffer_after_min = ?, price = ?, active = ? WHERE id = ?')
    .bind(next.service_id, next.name, next.duration_min, next.buffer_after_min, next.price, next.active, id)
    .run()
  return { ...next, id }
}

export async function listShifts(db: D1Database): Promise<WorkShift[]> {
  const result = await db.prepare('SELECT id, staff_id, weekday, start_min, end_min FROM work_shifts ORDER BY id').all<WorkShift>()
  return result.results
}

export async function createShift(db: D1Database, staffId: number, weekday: number, startMin: number, endMin: number): Promise<WorkShift> {
  return (await db
    .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?) RETURNING id, staff_id, weekday, start_min, end_min')
    .bind(staffId, weekday, startMin, endMin)
    .first<WorkShift>())!
}

export async function updateShift(db: D1Database, id: number, patch: ShiftPatch): Promise<WorkShift | null> {
  const current = await db.prepare('SELECT id, staff_id, weekday, start_min, end_min FROM work_shifts WHERE id = ?').bind(id).first<WorkShift>()
  if (!current) return null
  const next = { ...current, ...patch }
  await db
    .prepare('UPDATE work_shifts SET staff_id = ?, weekday = ?, start_min = ?, end_min = ? WHERE id = ?')
    .bind(next.staff_id, next.weekday, next.start_min, next.end_min, id)
    .run()
  return { ...next, id }
}

export async function deleteShift(db: D1Database, id: number): Promise<boolean> {
  const exists = await db.prepare('SELECT 1 FROM work_shifts WHERE id = ?').bind(id).first()
  if (!exists) return false
  await db.prepare('DELETE FROM work_shifts WHERE id = ?').bind(id).run()
  return true
}

export async function skillExists(db: D1Database, id: number): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM skills WHERE id = ?').bind(id).first())
}

export async function staffExists(db: D1Database, id: number): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM staff WHERE id = ?').bind(id).first())
}

export async function serviceExists(db: D1Database, id: number): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM services WHERE id = ?').bind(id).first())
}
