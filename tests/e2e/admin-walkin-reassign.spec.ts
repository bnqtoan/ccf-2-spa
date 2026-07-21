import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// Cùng cơ chế seed trực tiếp D1 local mà tests/e2e/admin-timeline.spec.ts đã
// dùng (T-12) — INSERT thẳng qua `wrangler d1 execute --local`, không bao giờ
// DELETE (nhiều agent/test chạy trên cùng D1 local).
const REPO_ROOT = new URL('../../', import.meta.url).pathname

function runSql(statements: string): void {
  const tmpFile = join(
    tmpdir(),
    `ccf-2-spa-e2e-walkin-reassign-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`,
  )
  writeFileSync(tmpFile, statements, 'utf8')
  try {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${tmpFile}`], {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        })
        return
      } catch (err) {
        const busy = String((err as { stderr?: Buffer })?.stderr ?? err).includes('SQLITE_BUSY')
        if (!busy || attempt === maxAttempts) throw err
        execFileSync('sleep', [String(0.3 * attempt)])
      }
    }
  } finally {
    unlinkSync(tmpFile)
  }
}

function querySql<T>(sql: string): T[] {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', sql],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  ).toString()
  const parsed = JSON.parse(out) as [{ results: T[] }]
  return parsed[0]?.results ?? []
}

/**
 * available-now / walk-ins dùng đồng hồ SERVER THẬT (`now = Date.now()`), khác
 * hẳn với timeline (T-12) vốn neo vào một ngày tương lai cố định — walk-in
 * KHÔNG có tham số ngày. Để tất định bất kể giờ chạy test thật, mỗi KTV riêng
 * của bộ test này được cấp ca làm việc PHỦ TRỌN 24 GIỜ (00:00–24:00) cho MỌI
 * ngày trong tuần (weekday 0-6), nên "đang bận ca" không bao giờ là lý do loại.
 */
const FULL_DAY_START_MIN = 0
const FULL_DAY_END_MIN = 1440

// Tag ngẫu nhiên cho mỗi lần chạy file — mọi tên (skill/staff/service/khách)
// đều mang tiền tố "E2E WR" + tag này để tự nhận diện & tự dọn, không đụng
// dữ liệu seed chuẩn hay của agent khác chạy song song.
const TAG = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const SKILL_NAME = `E2E WR Skill ${TAG}` // skill HIẾM, không staff chuẩn nào có
const SERVICE_NAME = `E2E WR Service ${TAG}`
const VARIANT_NAME = `E2E WR Variant ${TAG}`
// Mỗi test TẠO WALK-IN THẬT (POST /api/admin/walk-ins) sẽ chiếm KTV đó 35'
// (DURATION_MIN+BUFFER_MIN) tính từ lúc chạy — vì mode serial dùng chung một
// đồng hồ thật, tái dùng một KTV "rảnh" giữa hai test khác nhau sẽ khiến test
// sau thấy KTV đó bận thật ngoài ý muốn. Mỗi test cần một KTV rảnh RIÊNG.
const STAFF_FREE_WALKIN1 = `E2E WR Free1 ${TAG}` // walk-in test đầu tiên
const STAFF_FREE_WALKIN2 = `E2E WR Free2 ${TAG}` // walk-in "Khách lẻ"
const STAFF_FREE_UI = `E2E WR FreeUI ${TAG}` // test 3 (ẩn tạm) + test 4 (chỉ hiển thị, không bấm submit -> không bị chiếm)
const STAFF_FREE_BLOCKTARGET = `E2E WR FreeBT ${TAG}` // test 7,8: bị khoá bận CỤC BỘ theo khung giờ của item riêng từng test
const STAFF_FREE_REASSIGN = `E2E WR FreeR ${TAG}` // test 9: chuyển KTV thành công, phải luôn rảnh
const STAFF_FREE_POOL = [
  STAFF_FREE_WALKIN1,
  STAFF_FREE_WALKIN2,
  STAFF_FREE_UI,
  STAFF_FREE_BLOCKTARGET,
  STAFF_FREE_REASSIGN,
]
const STAFF_BUSY = `E2E WR Busy ${TAG}` // có skill, nhưng bận giờ đó (booking khác)
const STAFF_NO_SKILL = `E2E WR NoSkill ${TAG}` // KHÔNG có skill

const DURATION_MIN = 30
const BUFFER_MIN = 5
const PRICE = 100000

function esc(s: string): string {
  return s.replace(/'/g, "''")
}

/** Seed skill + service + variant + KTV (3 free riêng biệt/busy/no-skill), ca 24h mọi ngày. */
function seedBaseFixtures(): void {
  const stmts = [
    `INSERT INTO skills (name) VALUES ('${esc(SKILL_NAME)}');`,
    `INSERT INTO services (name, skill_id, body_zone, active)
       SELECT '${esc(SERVICE_NAME)}', id, 'body', 1 FROM skills WHERE name = '${esc(SKILL_NAME)}';`,
    `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       SELECT id, '${esc(VARIANT_NAME)}', ${DURATION_MIN}, ${BUFFER_MIN}, ${PRICE}, 1
       FROM services WHERE name = '${esc(SERVICE_NAME)}';`,
    `INSERT INTO staff (name, phone, active) VALUES ('${esc(STAFF_BUSY)}', NULL, 1);`,
    `INSERT INTO staff (name, phone, active) VALUES ('${esc(STAFF_NO_SKILL)}', NULL, 1);`,
    `INSERT INTO staff_skills (staff_id, skill_id)
       SELECT id, (SELECT id FROM skills WHERE name = '${esc(SKILL_NAME)}') FROM staff WHERE name = '${esc(STAFF_BUSY)}';`,
  ]
  for (const staffName of STAFF_FREE_POOL) {
    stmts.push(`INSERT INTO staff (name, phone, active) VALUES ('${esc(staffName)}', NULL, 1);`)
    stmts.push(
      `INSERT INTO staff_skills (staff_id, skill_id)
         SELECT id, (SELECT id FROM skills WHERE name = '${esc(SKILL_NAME)}') FROM staff WHERE name = '${esc(staffName)}';`,
    )
  }
  for (const staffName of [...STAFF_FREE_POOL, STAFF_BUSY, STAFF_NO_SKILL]) {
    for (let weekday = 0; weekday <= 6; weekday++) {
      stmts.push(
        `INSERT INTO work_shifts (staff_id, weekday, start_min, end_min)
           SELECT id, ${weekday}, ${FULL_DAY_START_MIN}, ${FULL_DAY_END_MIN} FROM staff WHERE name = '${esc(staffName)}';`,
      )
    }
  }
  runSql(stmts.join('\n'))
}

/** Khoá STAFF_BUSY bận NGAY BÂY GIỜ bằng một booking_item thật chồng giờ hiện tại. */
function seedBusyRightNow(): void {
  const now = Math.floor(Date.now() / 1000)
  const startAt = now - 300 // bắt đầu 5' trước, còn đang chạy
  const custName = `E2E WR BusyBlocker ${TAG}`
  runSql(`
INSERT INTO customers (name, phone) VALUES ('${esc(custName)}', NULL);
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE name = '${esc(custName)}'),
         ${startAt}, ${startAt} + 3600, 'in_service', 'walk_in', ${now};
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE customer_id = (SELECT id FROM customers WHERE name = '${esc(custName)}')),
    (SELECT id FROM staff WHERE name = '${esc(STAFF_BUSY)}'),
    (SELECT id FROM service_variants WHERE name = '${esc(VARIANT_NAME)}'),
    ${startAt}, ${startAt} + 3600, ${startAt} + 3600 + 60, 'in_service';
`)
}

/** Seed một booking_item mồ côi NGAY BÂY GIỜ (bị time_off đè lên), gán cho `ownerName`. */
function seedOrphanNow(ownerName: string, customerSuffix: string, phone: string | null): number {
  const now = Math.floor(Date.now() / 1000)
  const startAt = now - 120
  const custName = `E2E WR ${customerSuffix} ${TAG}`
  const phoneVal = phone === null ? 'NULL' : `'${esc(phone)}'`
  runSql(`
INSERT INTO customers (name, phone) VALUES ('${esc(custName)}', ${phoneVal});
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE name = '${esc(custName)}'),
         ${startAt}, ${startAt} + ${DURATION_MIN * 60}, 'booked', 'online', ${now};
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE customer_id = (SELECT id FROM customers WHERE name = '${esc(custName)}')),
    (SELECT id FROM staff WHERE name = '${esc(ownerName)}'),
    (SELECT id FROM service_variants WHERE name = '${esc(VARIANT_NAME)}'),
    ${startAt}, ${startAt} + ${DURATION_MIN * 60}, ${startAt} + ${DURATION_MIN * 60 + BUFFER_MIN * 60}, 'booked';
INSERT INTO time_off (staff_id, start_at, end_at, reason)
  SELECT id, ${startAt - 3600}, ${startAt + 3600 * 3}, 'E2E WR nghỉ đột xuất'
  FROM staff WHERE name = '${esc(ownerName)}';
`)
  const rows = querySql<{ id: number }>(
    `SELECT bi.id AS id FROM booking_items bi JOIN appointments a ON a.id = bi.appointment_id JOIN customers c ON c.id = a.customer_id WHERE c.name = '${esc(custName)}'`,
  )
  if (rows.length === 0) throw new Error(`Seed thất bại: không tìm thấy booking_item vừa tạo cho ${custName}`)
  return rows[0]!.id
}

/** Dọn mọi orphan còn sót từ lần chạy trước của CHÍNH FILE NÀY (tiền tố 'E2E WR')
 * bằng cách huỷ hợp lệ (không xoá dòng — CONVENTIONS §3), để hàng chờ rỗng
 * là kiểm chứng được tất định. */
function cancelAllPriorEwrOrphans(): void {
  runSql(`
UPDATE booking_items SET status = 'cancelled', cancelled_at = ${Math.floor(Date.now() / 1000)}
WHERE status IN ('booked','in_service')
  AND appointment_id IN (
    SELECT a.id FROM appointments a JOIN customers c ON c.id = a.customer_id
    WHERE c.name LIKE 'E2E WR %'
  );`)
}

/**
 * Dọn TOÀN BỘ hàng chờ xếp lại (reassign-queue là TOÀN CỤC, không lọc theo
 * ngày/tiền tố — bài học từ T-12): huỷ hợp lệ (không xoá dòng) mọi item đang
 * `booked`/`in_service` mà bị một `time_off` bất kỳ đè lên, đúng predicate mà
 * `loadReassignQueue` dùng. Đây là cách duy nhất để test "hàng chờ rỗng" tất
 * định, vì bất kỳ orphan nào còn sót từ lần chạy khác (kể cả của T-12) cũng
 * khiến EmptyState không bao giờ xuất hiện.
 */
function cancelEntireGlobalQueue(): void {
  runSql(`
UPDATE booking_items SET status = 'cancelled', cancelled_at = ${Math.floor(Date.now() / 1000)}
WHERE status IN ('booked','in_service')
  AND EXISTS (
    SELECT 1 FROM time_off t
    WHERE t.staff_id = booking_items.staff_id
      AND t.start_at < booking_items.block_end_at
      AND t.end_at   > booking_items.start_at
  );`)
}

async function openWalkInSheet(page: Page): Promise<void> {
  await page.getByTestId('walkin-fab').click()
  await expect(page.getByTestId('walkin-sheet')).toBeVisible()
}

test.describe('Admin — khách vãng lai + hàng chờ xếp lại', () => {
  // Serial: mỗi test ghi thẳng D1 local qua `wrangler d1 execute --local`,
  // giống lý do ở admin-timeline.spec.ts/customer-lookup.spec.ts.
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    seedBaseFixtures()
    cancelAllPriorEwrOrphans()
  })

  test('tạo khách vãng lai xong thì block mới hiện ngay trên timeline', async ({ page }) => {
    await page.goto('/admin/reassign')
    await openWalkInSheet(page)

    await page.getByTestId('walkin-service-select').selectOption({ label: SERVICE_NAME })
    const variantId1 = await page.evaluate((name) => {
      const select = document.querySelector('[data-testid="walkin-variant-select"]') as unknown as HTMLSelectElement
      const opt = Array.from(select.options).find((o) => o.textContent?.includes(name))
      return opt?.value ?? null
    }, VARIANT_NAME)
    await page.getByTestId('walkin-variant-select').selectOption(variantId1!)

    const staffButton = page.getByTestId('walkin-sheet').getByText(STAFF_FREE_WALKIN1)
    await expect(staffButton).toBeVisible()
    await staffButton.click()

    await page.getByTestId('walkin-name-input').fill('Nguyễn Thị Test')
    await page.getByTestId('walkin-phone-input').fill('0909123456')

    await page.getByTestId('walkin-submit').click()
    await expect(page.getByTestId('walkin-sheet')).not.toBeVisible()

    await page.goto('/admin/timeline')
    const block = page.locator('[data-testid^="booking-item-"]').filter({ hasText: 'Nguyễn Thị Test' })
    await expect(block.first()).toBeVisible({ timeout: 10_000 })
  })

  test('tạo khách vãng lai không nhập tên và SĐT thì hiện là "Khách lẻ"', async ({ page }) => {
    await page.goto('/admin/reassign')
    await openWalkInSheet(page)

    await page.getByTestId('walkin-service-select').selectOption({ label: SERVICE_NAME })
    const variantId = await page.evaluate((name) => {
      const select = document.querySelector('[data-testid="walkin-variant-select"]') as unknown as HTMLSelectElement
      const opt = Array.from(select.options).find((o) => o.textContent?.includes(name))
      return opt?.value ?? null
    }, VARIANT_NAME)
    await page.getByTestId('walkin-variant-select').selectOption(variantId!)

    const staffButton = page.getByTestId('walkin-sheet').getByText(STAFF_FREE_WALKIN2)
    await expect(staffButton).toBeVisible()
    await staffButton.click()

    // Cố tình để trống tên + SĐT.
    await page.getByTestId('walkin-submit').click()
    await expect(page.getByTestId('walkin-sheet')).not.toBeVisible()

    await page.goto('/admin/timeline')
    const block = page.locator('[data-testid^="booking-item-"]').filter({ hasText: 'Khách lẻ' })
    await expect(block.first()).toBeVisible({ timeout: 10_000 })
  })

  test('chọn dịch vụ mà không ai rảnh ngay bây giờ thì hiện thông báo không có ai rảnh, không có nút tiếp tục', async ({
    page,
  }) => {
    // STAFF_FREE_WALKIN1/2 có thể đã bận thật (do 2 test walk-in trước chiếm
    // 35'); STAFF_FREE_BLOCKTARGET/REASSIGN chưa chạy tới nên vẫn rảnh —
    // phải ẩn HẾT các free-staff khác để đảm bảo kịch bản "không ai rảnh"
    // đúng thật, không phải do trùng hợp thời gian. STAFF_BUSY bận sẵn qua
    // seedBusyRightNow(), STAFF_NO_SKILL thiếu skill — ẩn nốt các free-staff
    // bằng UPDATE active=0 hợp lệ (không xoá dòng), restore lại NGAY trong
    // cùng test (mode serial, không phá test chạy sau).
    seedBusyRightNow()
    for (const n of STAFF_FREE_POOL) {
      runSql(`UPDATE staff SET active = 0 WHERE name = '${esc(n)}';`)
    }

    try {
      await page.goto('/admin/reassign')
      await openWalkInSheet(page)

      await page.getByTestId('walkin-service-select').selectOption({ label: SERVICE_NAME })
      const variantId = await page.evaluate((name) => {
        const select = document.querySelector('[data-testid="walkin-variant-select"]') as unknown as HTMLSelectElement
        const opt = Array.from(select.options).find((o) => o.textContent?.includes(name))
        return opt?.value ?? null
      }, VARIANT_NAME)
      await page.getByTestId('walkin-variant-select').selectOption(variantId!)

      await expect(page.getByTestId('walkin-no-staff-notice')).toBeVisible()
      await expect(page.getByTestId('walkin-no-staff-notice')).toContainText('Không có ai rảnh')

      // Không có nút tiếp tục nghĩa là không hiện field tên/SĐT, và submit không có KTV để bấm.
      await expect(page.getByTestId('walkin-name-input')).toHaveCount(0)
      await expect(page.getByTestId('walkin-submit')).toBeDisabled()
    } finally {
      for (const n of STAFF_FREE_POOL) {
        runSql(`UPDATE staff SET active = 1 WHERE name = '${esc(n)}';`)
      }
    }
  })

  test('nút Bắt đầu phục vụ bị khoá khi chưa chọn KTV', async ({ page }) => {
    await page.goto('/admin/reassign')
    await openWalkInSheet(page)

    await page.getByTestId('walkin-service-select').selectOption({ label: SERVICE_NAME })
    const variantId = await page.evaluate((name) => {
      const select = document.querySelector('[data-testid="walkin-variant-select"]') as unknown as HTMLSelectElement
      const opt = Array.from(select.options).find((o) => o.textContent?.includes(name))
      return opt?.value ?? null
    }, VARIANT_NAME)
    await page.getByTestId('walkin-variant-select').selectOption(variantId!)

    await expect(page.getByTestId('walkin-sheet').getByText(STAFF_FREE_UI)).toBeVisible()
    // Chưa bấm chọn KTV nào — nút vẫn phải khoá.
    await expect(page.getByTestId('walkin-submit')).toBeDisabled()
  })

  test('sheet chuyển KTV hiện đúng lý do loại của từng KTV không đủ điều kiện', async ({ page }) => {
    const itemId = seedOrphanNow(STAFF_BUSY, 'ReasonGeneral', '0911000001')

    await page.goto('/admin/reassign')
    await page.getByTestId(`queue-reassign-${itemId}`).click()
    await expect(page.getByTestId('reassign-sheet')).toBeVisible()

    // STAFF_NO_SKILL phải hiện reason cụ thể, không phải nút mờ im lặng.
    const noSkillId = await staffIdByName(STAFF_NO_SKILL)
    await expect(page.getByTestId(`reassign-candidate-${noSkillId}`)).toBeDisabled()
    await expect(page.getByTestId(`reassign-reason-${noSkillId}`)).toBeVisible()
    await expect(page.getByTestId(`reassign-reason-${noSkillId}`)).not.toBeEmpty()
  })

  test('KTV thiếu kỹ năng trong sheet chuyển KTV hiện đúng lý do thiếu kỹ năng, không phải lý do chung chung', async ({
    page,
  }) => {
    const itemId = seedOrphanNow(STAFF_BUSY, 'ReasonSkill', '0911000002')

    await page.goto('/admin/reassign')
    await page.getByTestId(`queue-reassign-${itemId}`).click()
    await expect(page.getByTestId('reassign-sheet')).toBeVisible()

    const noSkillId = await staffIdByName(STAFF_NO_SKILL)
    await expect(page.getByTestId(`reassign-reason-${noSkillId}`)).toContainText('kỹ năng')
  })

  test('KTV đang bận giờ đó trong sheet chuyển KTV hiện đúng lý do đang bận', async ({ page }) => {
    const itemId = seedOrphanNow(STAFF_BUSY, 'ReasonBusy', '0911000003')

    // STAFF_FREE_BLOCKTARGET có skill nhưng mặc định đang rảnh -> eligible
    // true. Để kiểm đúng lý do "đang bận" (không phải "thiếu skill"), khoá
    // nó bận chồng giờ với CHÍNH item mồ côi này bằng một booking khác.
    const item = querySql<{ start_at: number; block_end_at: number }>(
      `SELECT start_at, block_end_at FROM booking_items WHERE id = ${itemId}`,
    )[0]!
    const custName = `E2E WR BusyForFree ${TAG}-${itemId}`
    runSql(`
INSERT INTO customers (name, phone) VALUES ('${esc(custName)}', NULL);
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE name = '${esc(custName)}'),
         ${item.start_at}, ${item.block_end_at}, 'booked', 'online', ${Math.floor(Date.now() / 1000)};
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE customer_id = (SELECT id FROM customers WHERE name = '${esc(custName)}')),
    (SELECT id FROM staff WHERE name = '${esc(STAFF_FREE_BLOCKTARGET)}'),
    (SELECT id FROM service_variants WHERE name = '${esc(VARIANT_NAME)}'),
    ${item.start_at}, ${item.block_end_at}, ${item.block_end_at}, 'booked';
`)

    await page.goto('/admin/reassign')
    await page.getByTestId(`queue-reassign-${itemId}`).click()
    await expect(page.getByTestId('reassign-sheet')).toBeVisible()

    const freeId = await staffIdByName(STAFF_FREE_BLOCKTARGET)
    await expect(page.getByTestId(`reassign-candidate-${freeId}`)).toBeDisabled()
    // Nguyên văn message thật từ API cho SLOT_TAKEN (src/worker/lib/reassign.ts
    // MESSAGES) — card yêu cầu hiện ĐÚNG nguyên văn, không tự diễn giải lại.
    await expect(page.getByTestId(`reassign-reason-${freeId}`)).toContainText('Đã có lịch khác trong khung giờ này')
  })

  test('khi không còn ai đủ điều kiện, hiện thông báo riêng kèm số điện thoại khách dạng tel: bấm gọi được', async ({
    page,
  }) => {
    // item mồ côi của STAFF_BUSY (chủ cũ, không tính vào candidates).
    // `loadOtherActiveStaff` trả về MỌI KTV active khác — để "không còn ai đủ
    // điều kiện" đúng thật (không phải trùng hợp thời gian), tạm ẩn toàn bộ
    // KTV có skill này (mọi free-staff của pool) bằng UPDATE active=0 hợp lệ
    // (không xoá dòng), restore lại ngay sau khi kiểm xong.
    const itemId = seedOrphanNow(STAFF_BUSY, 'NoneEligible', '0911999888')

    for (const n of STAFF_FREE_POOL) {
      runSql(`UPDATE staff SET active = 0 WHERE name = '${esc(n)}';`)
    }

    try {
      await page.goto('/admin/reassign')
      await page.getByTestId(`queue-reassign-${itemId}`).click()
      await expect(page.getByTestId('reassign-sheet')).toBeVisible()

      await expect(page.getByTestId('reassign-no-candidate-notice')).toBeVisible()
      await expect(page.getByTestId('reassign-no-candidate-notice')).toContainText('Không có ai nhận được')

      const telLink = page.getByTestId('reassign-call-customer')
      await expect(telLink).toBeVisible()
      await expect(telLink).toHaveAttribute('href', 'tel:0911999888')
    } finally {
      for (const n of STAFF_FREE_POOL) {
        runSql(`UPDATE staff SET active = 1 WHERE name = '${esc(n)}';`)
      }
    }
  })

  test('chuyển KTV thành công thì item rời khỏi hàng chờ xếp lại ngay lập tức', async ({ page }) => {
    const itemId = seedOrphanNow(STAFF_BUSY, 'ReassignOk', '0911000099')
    // STAFF_FREE_REASSIGN chưa từng bị chiếm bởi test nào khác trong file này
    // -> đảm bảo thật sự rảnh cho item này (không có blocker chồng giờ).

    await page.goto('/admin/reassign')
    await expect(page.getByTestId(`queue-item-${itemId}`)).toBeVisible()

    await page.getByTestId(`queue-reassign-${itemId}`).click()
    await expect(page.getByTestId('reassign-sheet')).toBeVisible()

    const freeId = await staffIdByName(STAFF_FREE_REASSIGN)
    const candidate = page.getByTestId(`reassign-candidate-${freeId}`)
    await expect(candidate).toBeEnabled()
    await candidate.click()

    await expect(page.getByTestId('reassign-sheet')).not.toBeVisible()
    await expect(page.getByTestId(`queue-item-${itemId}`)).not.toBeVisible()
  })

  test('huỷ một item trong hàng chờ thì item đó biến mất khỏi hàng chờ', async ({ page }) => {
    const itemId = seedOrphanNow(STAFF_BUSY, 'CancelOk', '0911000088')

    await page.goto('/admin/reassign')
    await expect(page.getByTestId(`queue-item-${itemId}`)).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId(`queue-cancel-${itemId}`).click()

    await expect(page.getByTestId(`queue-item-${itemId}`)).not.toBeVisible()
  })

  test('hàng chờ rỗng hiện trạng thái "không còn lịch nào cần xếp lại"', async ({ page }) => {
    // Hàng chờ TOÀN CỤC (không lọc ngày) — dọn sạch MỌI orphan còn sót, kể cả
    // của các bộ test khác (T-12), bằng huỷ hợp lệ (không xoá dòng).
    cancelEntireGlobalQueue()

    await page.goto('/admin/reassign')
    await expect(page.getByText('Không còn lịch nào cần xếp lại.')).toBeVisible()
  })
})

async function staffIdByName(name: string): Promise<string> {
  const rows = querySql<{ id: number }>(`SELECT id FROM staff WHERE name = '${esc(name)}'`)
  if (rows.length === 0) throw new Error(`Không tìm thấy KTV ${name}`)
  return String(rows[0]!.id)
}
