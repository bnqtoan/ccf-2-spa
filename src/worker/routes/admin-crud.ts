import { Hono } from 'hono'
import type { BodyZone } from '../db/types'
import * as crud from '../db/crud'

type Bindings = { DB: D1Database }
type Json = Record<string, unknown>

const routes = new Hono<{ Bindings: Bindings }>()
const bodyZones: BodyZone[] = ['hair', 'hands', 'feet', 'face', 'body']

function error(c: { json: (value: unknown, status: 404 | 409 | 422) => Response }, status: 404 | 409 | 422, code: 'NOT_FOUND' | 'VALIDATION', message: string) {
  return c.json({ error: { code, message } }, status)
}

function id(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalActive(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

async function json(c: { req: { json: () => Promise<unknown> } }): Promise<Json | null> {
  try {
    const value = await c.req.json()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
  } catch {
    return null
  }
}

function patchKeys(body: Json, keys: string[]): boolean {
  return keys.some((key) => body[key] !== undefined)
}

routes.get('/api/admin/skills', async (c) => c.json(await crud.listSkills(c.env.DB)))
routes.post('/api/admin/skills', async (c) => {
  const body = await json(c)
  if (!body || !text(body.name)) return error(c, 422, 'VALIDATION', 'name is required')
  return c.json(await crud.createSkill(c.env.DB, body.name.trim()), 201)
})
routes.patch('/api/admin/skills/:id', async (c) => {
  const skillId = id(c.req.param('id'))
  const body = await json(c)
  if (!skillId || !body || !text(body.name)) return error(c, 422, 'VALIDATION', 'name is required')
  const skill = await crud.updateSkill(c.env.DB, skillId, body.name.trim())
  return skill ? c.json(skill) : error(c, 404, 'NOT_FOUND', 'skill not found')
})
routes.delete('/api/admin/skills/:id', async (c) => {
  const skillId = id(c.req.param('id'))
  if (!skillId) return error(c, 404, 'NOT_FOUND', 'skill not found')
  const result = await crud.deleteSkillIfUnused(c.env.DB, skillId)
  if (result === 'not_found') return error(c, 404, 'NOT_FOUND', 'skill not found')
  if (result === 'in_use') return error(c, 409, 'VALIDATION', 'cannot delete a skill used by services')
  return c.body(null, 204)
})

routes.get('/api/admin/staff', async (c) => c.json(await crud.listStaff(c.env.DB)))
routes.post('/api/admin/staff', async (c) => {
  const body = await json(c)
  if (!body || !text(body.name) || (body.phone !== undefined && body.phone !== null && typeof body.phone !== 'string')) {
    return error(c, 422, 'VALIDATION', 'name is required and phone must be a string or null')
  }
  return c.json(await crud.createStaff(c.env.DB, body.name.trim(), (body.phone as string | null | undefined) ?? null), 201)
})
routes.patch('/api/admin/staff/:id', async (c) => {
  const staffId = id(c.req.param('id'))
  const body = await json(c)
  if (!staffId || !body || !patchKeys(body, ['name', 'phone', 'active']) || (body.name !== undefined && !text(body.name)) || (body.phone !== undefined && body.phone !== null && typeof body.phone !== 'string') || !optionalActive(body.active)) {
    return error(c, 422, 'VALIDATION', 'invalid staff update')
  }
  const patch: crud.StaffPatch = {}
  if (body.name !== undefined) patch.name = (body.name as string).trim()
  if (body.phone !== undefined) patch.phone = body.phone as string | null
  if (body.active !== undefined) patch.active = body.active ? 1 : 0
  const staff = await crud.updateStaff(c.env.DB, staffId, patch)
  return staff ? c.json(staff) : error(c, 404, 'NOT_FOUND', 'staff not found')
})
routes.post('/api/admin/staff/:id/skills', async (c) => {
  const staffId = id(c.req.param('id'))
  const body = await json(c)
  const skillId = body && number(body.skill_id) && body.skill_id > 0 ? body.skill_id : null
  if (!staffId || !skillId) return error(c, 422, 'VALIDATION', 'skill_id is required')
  if (!(await crud.staffExists(c.env.DB, staffId))) return error(c, 404, 'NOT_FOUND', 'staff not found')
  if (!(await crud.skillExists(c.env.DB, skillId))) return error(c, 404, 'NOT_FOUND', 'skill not found')
  await crud.assignSkillToStaff(c.env.DB, staffId, skillId)
  return c.json({ staff_id: staffId, skill_id: skillId }, 201)
})
routes.delete('/api/admin/staff/:id/skills/:skillId', async (c) => {
  const staffId = id(c.req.param('id'))
  const skillId = id(c.req.param('skillId'))
  if (!staffId || !skillId) return error(c, 404, 'NOT_FOUND', 'staff skill assignment not found')
  if (!(await crud.staffExists(c.env.DB, staffId)) || !(await crud.skillExists(c.env.DB, skillId))) return error(c, 404, 'NOT_FOUND', 'staff skill assignment not found')
  if (!(await crud.unassignSkillFromStaff(c.env.DB, staffId, skillId))) return error(c, 404, 'NOT_FOUND', 'staff skill assignment not found')
  return c.body(null, 204)
})

routes.get('/api/admin/services', async (c) => c.json(await crud.listServices(c.env.DB)))
routes.post('/api/admin/services', async (c) => {
  const body = await json(c)
  const skillId = body && number(body.skill_id) && body.skill_id > 0 ? body.skill_id : null
  if (!body || !text(body.name) || !skillId || !bodyZones.includes(body.body_zone as BodyZone)) return error(c, 422, 'VALIDATION', 'name, skill_id and body_zone are required')
  if (!(await crud.skillExists(c.env.DB, skillId))) return error(c, 422, 'VALIDATION', 'skill_id does not exist')
  return c.json(await crud.createService(c.env.DB, body.name.trim(), skillId, body.body_zone as BodyZone), 201)
})
routes.patch('/api/admin/services/:id', async (c) => {
  const serviceId = id(c.req.param('id'))
  const body = await json(c)
  const skillId = body && body.skill_id !== undefined ? (number(body.skill_id) && body.skill_id > 0 ? body.skill_id : null) : undefined
  if (!serviceId || !body || !patchKeys(body, ['name', 'skill_id', 'body_zone', 'active']) || (body.name !== undefined && !text(body.name)) || skillId === null || (body.body_zone !== undefined && !bodyZones.includes(body.body_zone as BodyZone)) || !optionalActive(body.active)) return error(c, 422, 'VALIDATION', 'invalid service update')
  if (skillId !== undefined && !(await crud.skillExists(c.env.DB, skillId))) return error(c, 422, 'VALIDATION', 'skill_id does not exist')
  const patch: crud.ServicePatch = {}
  if (body.name !== undefined) patch.name = (body.name as string).trim()
  if (skillId !== undefined) patch.skill_id = skillId
  if (body.body_zone !== undefined) patch.body_zone = body.body_zone as BodyZone
  if (body.active !== undefined) patch.active = body.active ? 1 : 0
  const service = await crud.updateService(c.env.DB, serviceId, patch)
  return service ? c.json(service) : error(c, 404, 'NOT_FOUND', 'service not found')
})

routes.get('/api/admin/variants', async (c) => c.json(await crud.listVariants(c.env.DB)))
routes.post('/api/admin/variants', async (c) => {
  const body = await json(c)
  const serviceId = body && number(body.service_id) && body.service_id > 0 ? body.service_id : null
  if (!body || !serviceId || !text(body.name) || !number(body.duration_min) || body.duration_min <= 0 || !number(body.buffer_after_min) || body.buffer_after_min < 0 || !number(body.price) || body.price < 0) return error(c, 422, 'VALIDATION', 'invalid variant')
  if (!(await crud.serviceExists(c.env.DB, serviceId))) return error(c, 422, 'VALIDATION', 'service_id does not exist')
  return c.json(await crud.createVariant(c.env.DB, serviceId, body.name.trim(), body.duration_min, body.buffer_after_min, body.price), 201)
})
routes.patch('/api/admin/variants/:id', async (c) => {
  const variantId = id(c.req.param('id'))
  const body = await json(c)
  const serviceId = body && body.service_id !== undefined ? (number(body.service_id) && body.service_id > 0 ? body.service_id : null) : undefined
  if (!variantId || !body || !patchKeys(body, ['service_id', 'name', 'duration_min', 'buffer_after_min', 'price', 'active']) || serviceId === null || (body.name !== undefined && !text(body.name)) || (body.duration_min !== undefined && (!number(body.duration_min) || body.duration_min <= 0)) || (body.buffer_after_min !== undefined && (!number(body.buffer_after_min) || body.buffer_after_min < 0)) || (body.price !== undefined && (!number(body.price) || body.price < 0)) || !optionalActive(body.active)) return error(c, 422, 'VALIDATION', 'invalid variant update')
  if (serviceId !== undefined && !(await crud.serviceExists(c.env.DB, serviceId))) return error(c, 422, 'VALIDATION', 'service_id does not exist')
  const patch: crud.VariantPatch = {}
  if (serviceId !== undefined) patch.service_id = serviceId
  if (body.name !== undefined) patch.name = (body.name as string).trim()
  if (body.duration_min !== undefined) patch.duration_min = body.duration_min as number
  if (body.buffer_after_min !== undefined) patch.buffer_after_min = body.buffer_after_min as number
  if (body.price !== undefined) patch.price = body.price as number
  if (body.active !== undefined) patch.active = body.active ? 1 : 0
  const variant = await crud.updateVariant(c.env.DB, variantId, patch)
  return variant ? c.json(variant) : error(c, 404, 'NOT_FOUND', 'variant not found')
})

function validShift(weekday: unknown, startMin: unknown, endMin: unknown): weekday is number {
  return number(weekday) && weekday >= 0 && weekday <= 6 && number(startMin) && number(endMin) && startMin >= 0 && endMin <= 1440 && startMin < endMin
}

routes.get('/api/admin/shifts', async (c) => c.json(await crud.listShifts(c.env.DB)))
routes.post('/api/admin/shifts', async (c) => {
  const body = await json(c)
  const staffId = body && number(body.staff_id) && body.staff_id > 0 ? body.staff_id : null
  if (!body || !staffId || !validShift(body.weekday, body.start_min, body.end_min)) return error(c, 422, 'VALIDATION', 'invalid shift')
  if (!(await crud.staffExists(c.env.DB, staffId))) return error(c, 422, 'VALIDATION', 'staff_id does not exist')
  return c.json(await crud.createShift(c.env.DB, staffId, body.weekday, body.start_min as number, body.end_min as number), 201)
})
routes.patch('/api/admin/shifts/:id', async (c) => {
  const shiftId = id(c.req.param('id'))
  const body = await json(c)
  if (!shiftId || !body || !patchKeys(body, ['staff_id', 'weekday', 'start_min', 'end_min'])) return error(c, 422, 'VALIDATION', 'invalid shift update')
  const existing = (await crud.listShifts(c.env.DB)).find((shift) => shift.id === shiftId)
  if (!existing) return error(c, 404, 'NOT_FOUND', 'shift not found')
  const staffId = body.staff_id === undefined ? existing.staff_id : body.staff_id
  const weekday = body.weekday === undefined ? existing.weekday : body.weekday
  const startMin = body.start_min === undefined ? existing.start_min : body.start_min
  const endMin = body.end_min === undefined ? existing.end_min : body.end_min
  if (!number(staffId) || staffId <= 0 || !validShift(weekday, startMin, endMin)) return error(c, 422, 'VALIDATION', 'invalid shift update')
  if (!(await crud.staffExists(c.env.DB, staffId))) return error(c, 422, 'VALIDATION', 'staff_id does not exist')
  const shift = await crud.updateShift(c.env.DB, shiftId, {
    staff_id: staffId,
    weekday,
    start_min: startMin as number,
    end_min: endMin as number,
  })
  return c.json(shift!)
})
routes.delete('/api/admin/shifts/:id', async (c) => {
  const shiftId = id(c.req.param('id'))
  if (!shiftId || !(await crud.deleteShift(c.env.DB, shiftId))) return error(c, 404, 'NOT_FOUND', 'shift not found')
  return c.body(null, 204)
})

export default routes
