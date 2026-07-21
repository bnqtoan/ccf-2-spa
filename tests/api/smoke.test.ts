import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('smoke: /api/health', () => {
  it('GET /api/health trả 200 và { ok: true }', async () => {
    const res = await exports.default.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('route API không tồn tại trả 404', async () => {
    const res = await exports.default.fetch('https://example.com/api/does-not-exist')
    expect(res.status).toBe(404)
  })
})
