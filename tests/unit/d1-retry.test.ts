import { describe, it, expect, vi } from 'vitest'
import { withD1Retry, isTransientD1Error } from '../../src/worker/lib/d1-retry.ts'

// T-CI-D1 — chứng minh HÀNH VI then-chốt của busy-retry: retry lỗi HẠ TẦNG
// thoáng qua, NÉM NGAY lỗi nghiệp vụ (không retry), và cạn số lần thử thì ném.
// Ràng buộc sống-còn: retry SLOT_TAKEN = double-booking im lặng → phải KHÔNG retry.

describe('withD1Retry — chỉ retry khoá hạ tầng, không retry lỗi nghiệp vụ', () => {
  it('retry một lỗi SQLITE_BUSY rồi thành công ở lần thử sau', async () => {
    let calls = 0
    const op = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('SQLITE_BUSY: database is locked')
      return 'ok'
    })
    await expect(withD1Retry(op)).resolves.toBe('ok')
    expect(op).toHaveBeenCalledTimes(2) // 1 lần đỏ (busy) + 1 lần xanh
  })

  it('retry cả lỗi "internal error" (D1 trả thoáng qua dưới tải)', async () => {
    let calls = 0
    const op = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('D1_ERROR: Failed to parse body as JSON, got: Error: internal error')
      return 42
    })
    await expect(withD1Retry(op)).resolves.toBe(42)
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('NÉM NGAY một lỗi nghiệp vụ SLOT_TAKEN — KHÔNG retry (chống double-booking)', async () => {
    const op = vi.fn(async () => {
      throw new Error('SLOT_TAKEN')
    })
    await expect(withD1Retry(op)).rejects.toThrow('SLOT_TAKEN')
    expect(op).toHaveBeenCalledTimes(1) // đúng MỘT lần — không thử lại
  })

  it('NÉM NGAY các lỗi nghiệp vụ khác (CANCEL_TOO_LATE / STAFF_LACKS_SKILL)', async () => {
    for (const code of ['CANCEL_TOO_LATE', 'STAFF_LACKS_SKILL']) {
      const op = vi.fn(async () => {
        throw new Error(code)
      })
      await expect(withD1Retry(op)).rejects.toThrow(code)
      expect(op).toHaveBeenCalledTimes(1)
    }
  })

  it('cạn số lần thử (luôn BUSY) thì ném lỗi busy cuối cùng', async () => {
    const op = vi.fn(async () => {
      throw new Error('SQLITE_BUSY')
    })
    await expect(withD1Retry(op)).rejects.toThrow('SQLITE_BUSY')
    expect(op).toHaveBeenCalledTimes(4) // MAX_ATTEMPTS
  })
})

describe('isTransientD1Error — phân loại đúng transient vs nghiệp vụ', () => {
  it('true cho các tín hiệu khoá hạ tầng', () => {
    expect(isTransientD1Error(new Error('SQLITE_BUSY'))).toBe(true)
    expect(isTransientD1Error(new Error('foo database is locked bar'))).toBe(true)
    expect(isTransientD1Error(new Error('Error: internal error; reference = abc'))).toBe(true)
  })
  it('false cho lỗi nghiệp vụ và lỗi thường', () => {
    expect(isTransientD1Error(new Error('SLOT_TAKEN'))).toBe(false)
    expect(isTransientD1Error(new Error('CANCEL_TOO_LATE'))).toBe(false)
    expect(isTransientD1Error(new Error('VALIDATION'))).toBe(false)
    expect(isTransientD1Error(new Error('boom'))).toBe(false)
  })
})
