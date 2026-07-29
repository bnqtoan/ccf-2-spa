// T-27 — Telegram nội bộ. Hai tầng test:
//   1. Unit thuần cho lib/notify.ts (mock fetch injectable, không đụng D1).
//   2. API thật (bookings/walk-ins/time-off) với global fetch mock + env
//      TELEGRAM_* set/xoá runtime — chứng minh:
//        - nội dung tin gửi đúng
//        - thiếu secret → NO-OP, không throw, nghiệp vụ vẫn 201/200
//        - Telegram trả lỗi 500 → nghiệp vụ VẪN thành công (không bị chặn)
//
// CONVENTIONS §8: `env` từ 'cloudflare:workers' là binding thật của test
// worker — set/xoá thuộc tính TELEGRAM_* runtime để mô phỏng "đã cấu hình" và
// "chưa cấu hình" mà không cần đổi vitest.config.ts (nếu đặt cố định ở đó thì
// case "thiếu secret" không còn cách nào tái tạo).

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { bookingMessage, sendTelegram, timeOffMessage } from '../../src/worker/lib/notify.ts'
import { adminCookieHeader } from './_authCookie.ts'

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

async function insertStaff(name: string, skillIds: number[]): Promise<number> {
  const r = await db
    .prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id')
    .bind(name)
    .first<{ id: number }>()
  for (const skillId of skillIds) {
    await db.prepare('INSERT INTO staff_skills (staff_id, skill_id) VALUES (?, ?)').bind(r!.id, skillId).run()
  }
  return r!.id
}

async function insertVariant(skillId: number, opts: { duration: number; buffer: number; name?: string }): Promise<number> {
  const svc = await db
    .prepare("INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, 'body', 1) RETURNING id")
    .bind(`Svc-${Math.random()}`, skillId)
    .first<{ id: number }>()
  const v = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, 100000, 1) RETURNING id`,
    )
    .bind(svc!.id, opts.name ?? `${opts.duration} phút`, opts.duration, opts.buffer)
    .first<{ id: number }>()
  return v!.id
}

async function insertShift(staffId: number, weekday: number, startMin: number, endMin: number): Promise<void> {
  await db
    .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)')
    .bind(staffId, weekday, startMin, endMin)
    .run()
}

async function insertAllDayShift(staffId: number): Promise<void> {
  for (let wd = 0; wd < 7; wd++) await insertShift(staffId, wd, 0, 1440)
}

async function postBooking(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function postWalkIn(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/admin/walk-ins', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await adminCookieHeader() },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function postTimeOff(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/admin/time-off', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await adminCookieHeader() },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/** Set TELEGRAM_* runtime trên binding `env` thật của worker test (CONVENTIONS
 *  §8 — không có cách nào khác để bật/tắt secret giữa các case trong CÙNG một
 *  vitest.config.ts, vì bindings ở đó là cố định cho toàn bộ file chạy). */
function setTelegramEnv(token: string | undefined, chatId: string | undefined): void {
  const e = env as unknown as Record<string, string | undefined>
  if (token === undefined) delete e.TELEGRAM_BOT_TOKEN
  else e.TELEGRAM_BOT_TOKEN = token
  if (chatId === undefined) delete e.TELEGRAM_CHAT_ID
  else e.TELEGRAM_CHAT_ID = chatId
}

/** Đợi hết các microtask/macrotask đang chờ — waitUntil chạy sau khi response
 *  trả về, nên các assertion trên side-effect (đã gọi fetch mock chưa) cần
 *  một nhịp chờ ngắn để chắc chắn promise trong waitUntil đã settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

// ===========================================================================
// 1) Unit thuần — lib/notify.ts (không D1, fetch injectable)
// ===========================================================================
describe('lib/notify — sendTelegram (thuần, fetch injectable)', () => {
  it('thiếu TELEGRAM_BOT_TOKEN → NO-OP, không gọi fetch, không throw', async () => {
    const calls: unknown[] = []
    const fakeFetch = (async (...args: unknown[]) => {
      calls.push(args)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await sendTelegram({ TELEGRAM_CHAT_ID: '123' }, 'hello', fakeFetch)

    expect(result).toEqual({ ok: false, reason: 'not_configured' })
    expect(calls.length).toBe(0)
  })

  it('thiếu TELEGRAM_CHAT_ID → NO-OP, không gọi fetch', async () => {
    const calls: unknown[] = []
    const fakeFetch = (async () => {
      calls.push(1)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await sendTelegram({ TELEGRAM_BOT_TOKEN: 'tok' }, 'hello', fakeFetch)

    expect(result).toEqual({ ok: false, reason: 'not_configured' })
    expect(calls.length).toBe(0)
  })

  it('đủ cấu hình → gọi đúng sendMessage với chat_id + text, trả ok:true', async () => {
    let capturedUrl = ''
    let capturedBody: any = null
    const fakeFetch = (async (url: any, init: any) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(init.body)
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch

    const result = await sendTelegram(
      { TELEGRAM_BOT_TOKEN: 'tok-123', TELEGRAM_CHAT_ID: 'chat-456' },
      'Đặt lịch mới: Khách A — Massage — 10:00 05/08 — KTV Lan',
      fakeFetch,
    )

    expect(result).toEqual({ ok: true })
    expect(capturedUrl).toBe('https://api.telegram.org/bottok-123/sendMessage')
    expect(capturedBody).toEqual({
      chat_id: 'chat-456',
      text: 'Đặt lịch mới: Khách A — Massage — 10:00 05/08 — KTV Lan',
    })
  })

  it('Telegram API trả lỗi 500 → trả ok:false, KHÔNG throw', async () => {
    const fakeFetch = (async () => new Response('server error', { status: 500 })) as typeof fetch

    const result = await sendTelegram({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'c' }, 'x', fakeFetch)

    expect(result).toEqual({ ok: false, reason: 'http_error' })
  })

  it('fetch reject (lỗi mạng) → trả ok:false, KHÔNG throw', async () => {
    const fakeFetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch

    const result = await sendTelegram({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'c' }, 'x', fakeFetch)

    expect(result).toEqual({ ok: false, reason: 'network_error' })
  })
})

describe('lib/notify — nội dung message', () => {
  it('bookingMessage nêu khách, dịch vụ, giờ, KTV', () => {
    const msg = bookingMessage({
      customerName: 'Khách A',
      variantName: 'Massage 60 phút',
      time: { hour: 10, minute: 0, day: 5, month: 8 },
      staffName: 'Lan',
    })
    expect(msg).toBe('Đặt lịch mới: Khách A — Massage 60 phút — 10:00 05/08 — KTV Lan')
  })

  it('timeOffMessage nêu số lịch cần xếp lại khi có affected_items', () => {
    const msg = timeOffMessage({
      staffName: 'Lan',
      start: { hour: 8, minute: 0, day: 5, month: 8 },
      end: { hour: 12, minute: 0, day: 5, month: 8 },
      affectedCount: 3,
    })
    expect(msg).toContain('KTV Lan nghỉ')
    expect(msg).toContain('3 lịch cần xếp lại')
  })

  it('timeOffMessage không có lịch bị ảnh hưởng → nêu rõ 0, không nói "cần xếp lại"', () => {
    const msg = timeOffMessage({
      staffName: 'Lan',
      start: { hour: 8, minute: 0, day: 5, month: 8 },
      end: { hour: 12, minute: 0, day: 5, month: 8 },
      affectedCount: 0,
    })
    expect(msg).toContain('không có lịch nào bị ảnh hưởng')
  })
})

// ===========================================================================
// 2) API thật — hook vào booking/walk-in/time-off qua waitUntil
// ===========================================================================
describe('booking mới → Telegram nội bộ nhận tin ngay (mock global fetch)', () => {
  beforeEach(async () => {
    await wipe()
    setTelegramEnv('test-bot-token', 'test-chat-id')
  })
  afterEach(() => {
    setTelegramEnv(undefined, undefined)
    vi.unstubAllGlobals()
  })

  it('online booking 201 → gọi Telegram sendMessage đúng nội dung', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15, name: 'Massage 60' })

    const startAt = Math.floor(Date.now() / 1000) + 10 * 24 * 3600 // ~10 days ahead, comfortably future
    // round down to a grid-aligned quarter hour to satisfy CONVENTIONS §6
    const aligned = startAt - (startAt % 900)

    const calls: { url: string; body: any }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000099' },
      variant_id: variant,
      start_at: aligned,
      staff_id: lan,
    })

    expect(status).toBe(201)
    await flush()

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://api.telegram.org/bottest-bot-token/sendMessage')
    expect(calls[0]!.body.chat_id).toBe('test-chat-id')
    expect(calls[0]!.body.text).toContain('Đặt lịch mới')
    expect(calls[0]!.body.text).toContain('Khách A')
    expect(calls[0]!.body.text).toContain('Massage 60')
    expect(calls[0]!.body.text).toContain('KTV Lan')
    expect(body.appointment).toBeDefined()
  })

  it('thiếu TELEGRAM_BOT_TOKEN → booking VẪN trả 201, KHÔNG gọi fetch Telegram', async () => {
    setTelegramEnv(undefined, undefined)
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const startAt = Math.floor(Date.now() / 1000) + 11 * 24 * 3600
    const aligned = startAt - (startAt % 900)

    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        calls.push(args)
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    const { status } = await postBooking({
      customer: { name: 'Khách B', phone: '0900000098' },
      variant_id: variant,
      start_at: aligned,
      staff_id: lan,
    })

    expect(status).toBe(201)
    await flush()
    expect(calls.length).toBe(0) // NO-OP: notify không hề gọi mạng
  })

  it('Telegram API trả lỗi 500 → booking VẪN thành công 201 (notify fail không chặn nghiệp vụ)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const startAt = Math.floor(Date.now() / 1000) + 12 * 24 * 3600
    const aligned = startAt - (startAt % 900)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )

    const { status, body } = await postBooking({
      customer: { name: 'Khách C', phone: '0900000097' },
      variant_id: variant,
      start_at: aligned,
      staff_id: lan,
    })

    expect(status).toBe(201)
    expect(body.appointment).toBeDefined()
    await flush()

    const appts = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(appts!.n).toBe(1) // ghi DB không bị ảnh hưởng bởi notify lỗi
  })

  it('fetch reject hoàn toàn (network lỗi) → booking VẪN 201', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const startAt = Math.floor(Date.now() / 1000) + 13 * 24 * 3600
    const aligned = startAt - (startAt % 900)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('DNS lỗi')
      }),
    )

    const { status } = await postBooking({
      customer: { name: 'Khách D', phone: '0900000096' },
      variant_id: variant,
      start_at: aligned,
      staff_id: lan,
    })

    expect(status).toBe(201)
    await flush()
  })
})

describe('walk-in mới → Telegram nội bộ nhận tin ngay', () => {
  beforeEach(async () => {
    await wipe()
    setTelegramEnv('test-bot-token', 'test-chat-id')
  })
  afterEach(() => {
    setTelegramEnv(undefined, undefined)
    vi.unstubAllGlobals()
  })

  it('walk-in 201 → gọi Telegram đúng 1 lần, nội dung có KTV + dịch vụ', async () => {
    const skill = await insertSkill('Nail')
    const mai = await insertStaff('Mai', [skill])
    await insertAllDayShift(mai)
    const variant = await insertVariant(skill, { duration: 45, buffer: 5, name: 'Nail Gel' })

    const calls: { body: any }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        calls.push({ body: JSON.parse(init.body) })
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    const { status, body } = await postWalkIn({
      variant_id: variant,
      staff_id: mai,
      customer: { name: 'Khách lẻ E' },
    })

    expect(status).toBe(201)
    expect(body.appointment).toBeDefined()
    await flush()

    expect(calls.length).toBe(1)
    expect(calls[0]!.body.text).toContain('Đặt lịch mới')
    expect(calls[0]!.body.text).toContain('Nail Gel')
    expect(calls[0]!.body.text).toContain('KTV Mai')
  })

  it('Telegram lỗi 500 → walk-in VẪN thành công 201', async () => {
    const skill = await insertSkill('Nail')
    const mai = await insertStaff('Mai', [skill])
    await insertAllDayShift(mai)
    const variant = await insertVariant(skill, { duration: 45, buffer: 5 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )

    const { status } = await postWalkIn({
      variant_id: variant,
      staff_id: mai,
      customer: { name: 'Khách lẻ F' },
    })

    expect(status).toBe(201)
    await flush()
  })
})

describe('KTV nghỉ (time-off) → Telegram nêu số lịch cần xếp lại', () => {
  beforeEach(async () => {
    await wipe()
    setTelegramEnv('test-bot-token', 'test-chat-id')
  })
  afterEach(() => {
    setTelegramEnv(undefined, undefined)
    vi.unstubAllGlobals()
  })

  it('time-off có affected_items → message nêu đúng số lịch cần xếp lại', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Seed 2 booking sống của Lan để bị time-off "nuốt".
    const base = Math.floor(Date.now() / 1000) + 14 * 24 * 3600
    const s1 = base - (base % 900)
    const s2 = s1 + 3 * 3600
    for (const s of [s1, s2]) {
      const cust = await db
        .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
        .bind(`C-${Math.random()}`)
        .first<{ id: number }>()
      const appt = await db
        .prepare(
          `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
           VALUES (?, ?, ?, 'booked', 'online', 0) RETURNING id`,
        )
        .bind(cust!.id, s, s + 3600)
        .first<{ id: number }>()
      await db
        .prepare(
          `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'booked')`,
        )
        .bind(appt!.id, lan, variant, s, s + 3600, s + 3600 + 900)
        .run()
    }

    const calls: { body: any }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        calls.push({ body: JSON.parse(init.body) })
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    const { status, body } = await postTimeOff({
      staff_id: lan,
      start_at: s1 - 3600,
      end_at: s2 + 3600 * 2,
      reason: 'ốm',
    })

    expect(status).toBe(200)
    expect(body.affected_items.length).toBe(2)
    await flush()

    expect(calls.length).toBe(1)
    expect(calls[0]!.body.text).toContain('KTV Lan nghỉ')
    expect(calls[0]!.body.text).toContain('2 lịch cần xếp lại')
  })

  it('Telegram lỗi 500 → time-off VẪN ghi DB thành công (không bị chặn)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )

    const startAt = Math.floor(Date.now() / 1000) + 15 * 24 * 3600
    const { status, body } = await postTimeOff({
      staff_id: lan,
      start_at: startAt,
      end_at: startAt + 3600,
      reason: 'ốm',
    })

    expect(status).toBe(200)
    expect(body.time_off).toBeDefined()

    const row = await db.prepare('SELECT COUNT(*) AS n FROM time_off').first<{ n: number }>()
    expect(row!.n).toBe(1)
  })
})

describe('route khách/webhook không bị notify chặn — /api/health vẫn OK khi Telegram env set', () => {
  beforeEach(() => setTelegramEnv('test-bot-token', 'test-chat-id'))
  afterEach(() => {
    setTelegramEnv(undefined, undefined)
    vi.unstubAllGlobals()
  })

  it('GET /api/health không đụng notify, không gọi fetch', async () => {
    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        calls.push(args)
        return new Response('{}', { status: 200 })
      }),
    )
    const res = await exports.default.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(calls.length).toBe(0)
  })
})
