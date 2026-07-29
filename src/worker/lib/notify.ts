// Telegram nội bộ — bot báo lễ tân/admin, KHÔNG BAO GIỜ gửi khách (T-27 / PRD R6).
//
// ============================================================================
// LUẬT SỐNG CÒN CỦA FILE NÀY
// ============================================================================
// notify KHÔNG ĐƯỢC làm hỏng/chặn nghiệp vụ. Booking / time-off phải thành
// công bất kể Telegram lỗi, timeout, hay chưa cấu hình secret. Vì vậy:
//   - `sendTelegram` không bao giờ throw ra ngoài — mọi lỗi (fetch reject,
//     HTTP non-2xx, JSON hỏng) được nuốt và trả về `{ ok: false }`.
//   - Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID → NO-OP im lặng, trả
//     `{ ok: false, reason: 'not_configured' }`, KHÔNG gọi fetch.
//   - Route gọi qua `c.executionCtx.waitUntil(notifyXxx(...))` — không await
//     trực tiếp trong luồng response, nên dù notify chậm/treo cũng không giữ
//     khách/lễ tân chờ.
//
// Adapter thuần: fetch injectable (mặc định `globalThis.fetch`) để test được
// mock-fetch mà không đụng mạng thật — cùng tinh thần với payments/*.ts.
// ============================================================================

export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
}

export type NotifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'http_error' | 'network_error' }

type FetchLike = typeof fetch

/**
 * Gửi một tin nhắn text tới chat nội bộ qua Telegram Bot API `sendMessage`.
 * Không throw trong bất kỳ trường hợp nào — luôn trả `NotifyResult`.
 */
export async function sendTelegram(
  env: NotifyEnv,
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<NotifyResult> {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (token === undefined || token === '' || chatId === undefined || chatId === '') {
    return { ok: false, reason: 'not_configured' }
  }

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    if (!res.ok) {
      return { ok: false, reason: 'http_error' }
    }
    return { ok: true }
  } catch {
    // fetch reject (mạng lỗi, timeout, DNS...) — nuốt, không throw.
    return { ok: false, reason: 'network_error' }
  }
}

/** `HH:mm dd/MM` giờ SPA_TZ — dùng chung cho mọi message. Nhận parts đã format
 *  sẵn từ lib/time.ts để notify.ts không phải tự làm timezone math. */
export interface NotifyTimeParts {
  hour: number
  minute: number
  day: number
  month: number
}

function fmtTime(p: NotifyTimeParts): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}`
}

/** Nội dung: "Đặt lịch mới: [khách] [dịch vụ] [giờ] [KTV]" (PRD, card §Việc phải làm). */
export function bookingMessage(input: {
  customerName: string
  variantName: string
  time: NotifyTimeParts
  staffName: string
}): string {
  return `Đặt lịch mới: ${input.customerName} — ${input.variantName} — ${fmtTime(input.time)} — KTV ${input.staffName}`
}

/** Nội dung: "KTV [tên] nghỉ [khoảng], N lịch cần xếp lại". */
export function timeOffMessage(input: {
  staffName: string
  start: NotifyTimeParts
  end: NotifyTimeParts
  affectedCount: number
}): string {
  const base = `KTV ${input.staffName} nghỉ ${fmtTime(input.start)} - ${fmtTime(input.end)}`
  if (input.affectedCount <= 0) return `${base}, không có lịch nào bị ảnh hưởng.`
  return `${base}, ${input.affectedCount} lịch cần xếp lại.`
}
