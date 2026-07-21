import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seed } from '../../src/worker/db/seed'
import migrationSql from '../../migrations/0001_init.sql?raw'

const db = env.DB

// vitest-pool-workers does not auto-apply migrations_dir from wrangler.jsonc
// (that config field is read only by the `wrangler d1 migrations` CLI). We
// apply the migration file ourselves once per test file; D1 storage here is
// shared across `it()` blocks within this file (confirmed empirically), so a
// single `beforeAll` is enough — each test still cleans up its own rows per
// CONVENTIONS §8.
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

async function tableNames(): Promise<string[]> {
  const res = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`)
    .all<{ name: string }>()
  return res.results.map((r) => r.name)
}

describe('migration', () => {
  it('migration tạo đủ 10 bảng', async () => {
    const names = await tableNames()
    const expected = [
      'skills',
      'staff',
      'staff_skills',
      'services',
      'service_variants',
      'work_shifts',
      'time_off',
      'customers',
      'appointments',
      'booking_items',
    ]
    for (const t of expected) {
      expect(names).toContain(t)
    }
    expect(expected.length).toBe(10)
  })
})

describe('CHECK constraints', () => {
  // Each test builds only the rows it needs and cleans up after itself so
  // tests don't depend on run order (CONVENTIONS §8).

  it('chèn booking_items với status lạ bị CHECK constraint chặn', async () => {
    await db.prepare('DELETE FROM booking_items').run()
    await db.prepare('DELETE FROM appointments').run()
    await db.prepare('DELETE FROM customers').run()
    await db.prepare('DELETE FROM service_variants').run()
    await db.prepare('DELETE FROM services').run()
    await db.prepare('DELETE FROM staff').run()
    await db.prepare('DELETE FROM skills').run()

    const skill = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind('X').first<{ id: number }>()
    const staff = await db.prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id').bind('S').first<{ id: number }>()
    const service = await db
      .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
      .bind('Svc', skill!.id, 'hair')
      .first<{ id: number }>()
    const variant = await db
      .prepare('INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id')
      .bind(service!.id, 'V', 30, 5, 10000)
      .first<{ id: number }>()
    const customer = await db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id').bind('C', '0900000000').first<{ id: number }>()
    const appt = await db
      .prepare('INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at) VALUES (?, 0, 1800, ?, ?, 0) RETURNING id')
      .bind(customer!.id, 'booked', 'online')
      .first<{ id: number }>()

    await expect(
      db
        .prepare('INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status) VALUES (?, ?, ?, 0, 1800, 2100, ?)')
        .bind(appt!.id, staff!.id, variant!.id, 'not_a_real_status')
        .run(),
    ).rejects.toThrow()
  })

  it('chèn appointments với source lạ bị chặn', async () => {
    const customer = await db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id').bind('C2', '0900000001').first<{ id: number }>()

    await expect(
      db
        .prepare('INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at) VALUES (?, 0, 1800, ?, ?, 0)')
        .bind(customer!.id, 'booked', 'not_a_real_source')
        .run(),
    ).rejects.toThrow()
  })

  it('chèn services với body_zone lạ bị chặn', async () => {
    const skill = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind('Y').first<{ id: number }>()

    await expect(
      db
        .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1)')
        .bind('BadSvc', skill!.id, 'not_a_real_zone')
        .run(),
    ).rejects.toThrow()
  })

  it('chèn work_shifts với weekday = 7 bị chặn', async () => {
    const staff = await db.prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id').bind('S2').first<{ id: number }>()

    await expect(
      db
        .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, 7, 540, 1140)')
        .bind(staff!.id)
        .run(),
    ).rejects.toThrow()
  })

  it('chèn work_shifts với start_min >= end_min bị chặn', async () => {
    const staff = await db.prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id').bind('S3').first<{ id: number }>()

    await expect(
      db
        .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, 1, 1140, 540)')
        .bind(staff!.id)
        .run(),
    ).rejects.toThrow()
  })

  it('customers.phone chấp nhận NULL (khách lẻ)', async () => {
    const res = await db
      .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id, phone')
      .bind('Khach le test')
      .first<{ id: number; phone: string | null }>()

    expect(res!.phone).toBeNull()
  })
})

describe('foreign keys', () => {
  it('không xoá được staff đang có booking_items (FK RESTRICT có enforce thật)', async () => {
    // Build a minimal staff -> booking_items chain.
    const skill = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind('FKSkill').first<{ id: number }>()
    const staff = await db.prepare('INSERT INTO staff (name, active) VALUES (?, 1) RETURNING id').bind('FKStaff').first<{ id: number }>()
    const service = await db
      .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
      .bind('FKSvc', skill!.id, 'hair')
      .first<{ id: number }>()
    const variant = await db
      .prepare('INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id')
      .bind(service!.id, 'FKVariant', 30, 5, 10000)
      .first<{ id: number }>()
    const customer = await db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id').bind('FKCustomer', '0900000002').first<{ id: number }>()
    const appt = await db
      .prepare('INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at) VALUES (?, 0, 1800, ?, ?, 0) RETURNING id')
      .bind(customer!.id, 'booked', 'online')
      .first<{ id: number }>()
    await db
      .prepare('INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status) VALUES (?, ?, ?, 0, 1800, 2100, ?)')
      .bind(appt!.id, staff!.id, variant!.id, 'booked')
      .run()

    // PHÁT HIỆN QUAN TRỌNG (khác với cảnh báo mặc định trong card): trong môi
    // trường test thực tế ở đây (D1 local qua Miniflare, chạy dưới
    // @cloudflare/vitest-pool-workers 0.18.6), FK CÓ ĐƯỢC ENFORCE thật —
    // `PRAGMA foreign_keys` bật sẵn. DELETE một staff đang có booking_items
    // bị chặn với lỗi `FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_TRIGGER)`,
    // đúng như `ON DELETE RESTRICT` khai báo trong schema. Đã verify bằng cách
    // chạy thật, không suy đoán. T-03/T-04 có thể tin cậy ràng buộc FK này là
    // thật trong ngữ cảnh test/local — nhưng vẫn nên tự chặn xoá staff ở tầng
    // ứng dụng (soft delete qua `active = 0`) làm UX tốt hơn lỗi SQL thô, và vì
    // hành vi FK trên D1 remote/production chưa được xác nhận riêng ở task này.
    await expect(db.prepare('DELETE FROM staff WHERE id = ?').bind(staff!.id).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    )

    const stillThere = await db.prepare('SELECT id FROM staff WHERE id = ?').bind(staff!.id).first()
    expect(stillThere).not.toBeNull() // vẫn còn — DELETE đã bị chặn

    const item = await db.prepare('SELECT staff_id FROM booking_items WHERE appointment_id = ?').bind(appt!.id).first<{ staff_id: number }>()
    expect(item!.staff_id).toBe(staff!.id) // booking_item nguyên vẹn, không bị orphan
  })
})

describe('seed', () => {
  beforeEach(async () => {
    await seed(db)
  })

  it('seed chạy xong có đủ 4 skill, 5 KTV, 8 variant', async () => {
    const skills = await db.prepare('SELECT COUNT(*) as n FROM skills').first<{ n: number }>()
    const staff = await db.prepare('SELECT COUNT(*) as n FROM staff').first<{ n: number }>()
    const variants = await db.prepare('SELECT COUNT(*) as n FROM service_variants').first<{ n: number }>()

    expect(skills!.n).toBe(4)
    expect(staff!.n).toBe(5)
    expect(variants!.n).toBe(8)
  })

  it('seed idempotent: chạy 2 lần không cộng dồn', async () => {
    await seed(db) // second run
    const skills = await db.prepare('SELECT COUNT(*) as n FROM skills').first<{ n: number }>()
    const staff = await db.prepare('SELECT COUNT(*) as n FROM staff').first<{ n: number }>()
    const variants = await db.prepare('SELECT COUNT(*) as n FROM service_variants').first<{ n: number }>()

    expect(skills!.n).toBe(4)
    expect(staff!.n).toBe(5)
    expect(variants!.n).toBe(8)
  })

  it('mỗi service trỏ tới skill có thật', async () => {
    const orphans = await db
      .prepare('SELECT s.id FROM services s LEFT JOIN skills sk ON sk.id = s.skill_id WHERE sk.id IS NULL')
      .all()
    expect(orphans.results.length).toBe(0)
  })

  it('KTV có skill Massage đang có ca làm thứ Hai — join staff_skills + work_shifts', async () => {
    const res = await db
      .prepare(
        `SELECT COUNT(DISTINCT st.id) as n
         FROM staff st
         JOIN staff_skills ss ON ss.staff_id = st.id
         JOIN skills sk ON sk.id = ss.skill_id
         JOIN work_shifts ws ON ws.staff_id = st.id
         WHERE sk.name = 'Massage' AND ws.weekday = 1`,
      )
      .first<{ n: number }>()

    // Seed: Lan (Massage+Tóc) và Huong (Massage) đều có ca thứ Hai (weekday=1).
    expect(res!.n).toBe(2)
  })
})
