// Seed data for dev/test. Idempotent: wipes all rows (children first, FK
// order) before inserting, so re-running never duplicates or violates a
// CHECK/FK constraint.
//
// Two entry points share the same statement list so there is exactly one
// source of truth for the seed dataset:
//   - `seed(db)`            — used by tests, runs through the D1 binding.
//   - `buildSeedStatements()` — used by the `db:seed:local` CLI script (see
//     package.json), which has no D1 binding available outside a Worker and
//     instead feeds the same SQL through `wrangler d1 execute --local`.

const TABLES_IN_DELETE_ORDER = [
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
] as const

export interface SeedStatement {
  sql: string
  params: (string | number | null)[]
}

// 4 skills
const SKILL_NAMES = ['Massage', 'Tóc', 'Móng', 'Da mặt'] as const
type SkillName = (typeof SKILL_NAMES)[number]

// 5 KTV, overlapping skills. Lan has 2 skills (Massage + Tóc); Yen has
// exactly 1 skill (Da mặt only) — the spread the card requires.
// commission: hoa hồng theo tỉ lệ doanh thu (0.30 = 30%). Đặt sẵn vài KTV để
// màn /admin/overview có số lương thật khi bấm vào KTV. Yen để 0 (mặc định) —
// minh chứng "chưa cấu hình = lương 0", không phải số bất ngờ.
const STAFF_DEFS = [
  { name: 'Lan', phone: '0901000001', skills: ['Massage', 'Tóc'] as SkillName[], commission: 0.35 },
  { name: 'Huong', phone: '0901000002', skills: ['Massage'] as SkillName[], commission: 0.3 },
  { name: 'Mai', phone: '0901000003', skills: ['Móng'] as SkillName[], commission: 0.4 },
  { name: 'Trang', phone: '0901000004', skills: ['Móng', 'Da mặt'] as SkillName[], commission: 0.25 },
  { name: 'Yen', phone: '0901000005', skills: ['Da mặt'] as SkillName[], commission: 0 },
] as const

// 4 services x 2 variants each = 8 variants. Buffers vary 5/10/15 minutes.
const SERVICE_DEFS = [
  {
    name: 'Massage toàn thân',
    skill: 'Massage' as SkillName,
    body_zone: 'body',
    variants: [
      { name: '60 phút', duration_min: 60, buffer_after_min: 10, price: 350000 },
      { name: '90 phút', duration_min: 90, buffer_after_min: 15, price: 500000 },
    ],
  },
  {
    name: 'Cắt gội',
    skill: 'Tóc' as SkillName,
    body_zone: 'hair',
    variants: [
      { name: 'Gội cơ bản', duration_min: 30, buffer_after_min: 5, price: 100000 },
      { name: 'Cắt + gội', duration_min: 45, buffer_after_min: 10, price: 180000 },
    ],
  },
  {
    name: 'Chăm sóc móng',
    skill: 'Móng' as SkillName,
    body_zone: 'hands',
    variants: [
      { name: 'Sơn gel', duration_min: 45, buffer_after_min: 5, price: 150000 },
      { name: 'Đắp bột', duration_min: 75, buffer_after_min: 10, price: 300000 },
    ],
  },
  {
    name: 'Chăm sóc da mặt',
    skill: 'Da mặt' as SkillName,
    body_zone: 'face',
    variants: [
      { name: 'Cơ bản', duration_min: 45, buffer_after_min: 10, price: 250000 },
      { name: 'Chuyên sâu', duration_min: 75, buffer_after_min: 15, price: 450000 },
    ],
  },
] as const

const START_MIN = 9 * 60
const END_MIN = 19 * 60

// Anchor sample bookings to "today" (UTC midnight) so they're always in a
// deterministic, reasoned-about window regardless of when seed runs.
function daySeedAnchor(): number {
  const now = Math.floor(Date.now() / 1000)
  return now - (now % 86400)
}

/**
 * Builds the full ordered list of seed statements (DELETE then INSERT, in FK
 * order). Uses subqueries (not literal ids) to look up FK targets by natural
 * key, so the statements are agnostic to actual AUTOINCREMENT values — safe
 * to run against a freshly wiped table repeatedly.
 */
export function buildSeedStatements(): SeedStatement[] {
  const stmts: SeedStatement[] = []
  const now = Math.floor(Date.now() / 1000)
  const dayStart = daySeedAnchor()

  for (const table of TABLES_IN_DELETE_ORDER) {
    stmts.push({ sql: `DELETE FROM ${table}`, params: [] })
  }

  for (const name of SKILL_NAMES) {
    stmts.push({ sql: 'INSERT INTO skills (name) VALUES (?)', params: [name] })
  }

  for (const s of STAFF_DEFS) {
    stmts.push({
      sql: 'INSERT INTO staff (name, phone, active, commission_rate) VALUES (?, ?, 1, ?)',
      params: [s.name, s.phone, s.commission],
    })
    for (const skillName of s.skills) {
      stmts.push({
        sql: `INSERT INTO staff_skills (staff_id, skill_id)
              VALUES ((SELECT id FROM staff WHERE name = ?), (SELECT id FROM skills WHERE name = ?))`,
        params: [s.name, skillName],
      })
    }
  }

  for (const svc of SERVICE_DEFS) {
    stmts.push({
      sql: `INSERT INTO services (name, skill_id, body_zone, active)
            VALUES (?, (SELECT id FROM skills WHERE name = ?), ?, 1)`,
      params: [svc.name, svc.skill, svc.body_zone],
    })
    for (const v of svc.variants) {
      stmts.push({
        sql: `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
              VALUES ((SELECT id FROM services WHERE name = ?), ?, ?, ?, ?, 1)`,
        params: [svc.name, v.name, v.duration_min, v.buffer_after_min, v.price],
      })
    }
  }

  // Work shifts: 09:00-19:00 every weekday (Mon..Sat, weekday 1..6) for all
  // staff. Sunday (0) off.
  for (const s of STAFF_DEFS) {
    for (let weekday = 1; weekday <= 6; weekday++) {
      stmts.push({
        sql: `INSERT INTO work_shifts (staff_id, weekday, start_min, end_min)
              VALUES ((SELECT id FROM staff WHERE name = ?), ?, ?, ?)`,
        params: [s.name, weekday, START_MIN, END_MIN],
      })
    }
  }

  // Trang nghỉ CẢ NGÀY hôm nay — để màn /admin/overview có một KTV hiện "Nghỉ"
  // thật, chứng minh nhánh occupancy=null (nghỉ được trừ khỏi mẫu số, không hiện
  // 0% oan). Phủ rộng [dayStart-6h, dayStart+30h] để chắc chắn trùm trọn ca
  // 09:00–19:00 GIỜ ĐỊA PHƯƠNG bất kể lệch UTC (dayStart ở đây là nửa đêm UTC).
  {
    const offStart = dayStart - 6 * 3600
    const offEnd = dayStart + 30 * 3600
    stmts.push({
      sql: `INSERT INTO time_off (staff_id, start_at, end_at, reason)
            VALUES ((SELECT id FROM staff WHERE name = 'Trang'), ?, ?, 'nghỉ phép')`,
      params: [offStart, offEnd],
    })
  }

  // Sample customers: one with a phone, one anonymous walk-in (phone NULL).
  stmts.push({
    sql: 'INSERT INTO customers (name, phone) VALUES (?, ?)',
    params: ['Khach Seed 1', '0912345678'],
  })
  stmts.push({
    sql: 'INSERT INTO customers (name, phone) VALUES (?, NULL)',
    params: ['Khach le'],
  })

  // Sample bookings so overlap/availability AND the /admin/overview measurement
  // surface have real data. Statuses are chosen so the dashboard shows non-zero,
  // non-trivial numbers:
  //   - Lan Massage 60' @10:00  → status 'done'    (counts toward revenue+payroll)
  //   - Mai Móng Sơn gel @11:00 → status 'done'    (counts toward revenue+payroll)
  //   - Lan Cắt+gọi @14:00      → status 'no_show' (EXCLUDED from revenue; feeds no-show KPI)
  const BOOKINGS = [
    {
      customer: 'Khach Seed 1',
      source: 'online',
      staff: 'Lan',
      service: 'Massage toàn thân',
      variant: '60 phút',
      hour: 10,
      status: 'done',
    },
    {
      customer: 'Khach le',
      source: 'walk_in',
      staff: 'Mai',
      service: 'Chăm sóc móng',
      variant: 'Sơn gel',
      hour: 11,
      status: 'done',
    },
    {
      customer: 'Khach Seed 1',
      source: 'online',
      staff: 'Lan',
      service: 'Cắt gội',
      variant: 'Cắt + gội',
      hour: 14,
      status: 'no_show',
    },
  ] as const

  for (const b of BOOKINGS) {
    const at = dayStart + b.hour * 3600
    stmts.push({
      sql: `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
            SELECT (SELECT id FROM customers WHERE name = ?),
                   ?,
                   ? + sv.duration_min * 60,
                   ?, ?, ?
            FROM service_variants sv
            JOIN services s ON s.id = sv.service_id
            WHERE s.name = ? AND sv.name = ?`,
      params: [b.customer, at, at, b.status, b.source, now, b.service, b.variant],
    })
    stmts.push({
      sql: `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
            SELECT
              (SELECT id FROM appointments WHERE source = ? AND start_at = ?),
              (SELECT id FROM staff WHERE name = ?),
              sv.id,
              ?,
              ? + sv.duration_min * 60,
              ? + sv.duration_min * 60 + sv.buffer_after_min * 60,
              ?
            FROM service_variants sv
            JOIN services s ON s.id = sv.service_id
            WHERE s.name = ? AND sv.name = ?`,
      params: [b.source, at, b.staff, at, at, at, b.status, b.service, b.variant],
    })
  }

  return stmts
}

export async function seed(db: D1Database): Promise<void> {
  for (const { sql, params } of buildSeedStatements()) {
    await db
      .prepare(sql)
      .bind(...params)
      .run()
  }
}

// --- CLI entrypoint (npm run db:seed:local) -------------------------------
//
// There is no D1 binding available outside a Worker, so the CLI path can't
// call `seed()` directly. Instead it inlines the same `buildSeedStatements()`
// data into literal SQL (safe here — every value is a hardcoded seed
// constant, never user input) and pipes it through
// `wrangler d1 execute --local --file=`, the supported way to run arbitrary
// SQL against the same local D1 store `wrangler dev` and the test pool use.
if (import.meta.main) {
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  function sqlLiteral(value: string | number | null): string {
    if (value === null) return 'NULL'
    if (typeof value === 'number') return String(value)
    return `'${value.replace(/'/g, "''")}'`
  }

  const sqlText = buildSeedStatements()
    .map(({ sql, params }) => {
      let i = 0
      const inlined = sql.replace(/\?/g, () => sqlLiteral(params[i++]!))
      return inlined + ';'
    })
    .join('\n')

  const tmpFile = join(tmpdir(), `ccf-2-spa-seed-${Date.now()}.sql`)
  writeFileSync(tmpFile, sqlText, 'utf8')
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${tmpFile}`], {
      stdio: 'inherit',
      cwd: new URL('../../../', import.meta.url).pathname,
    })
  } finally {
    unlinkSync(tmpFile)
  }
}
