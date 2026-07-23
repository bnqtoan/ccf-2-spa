import { useEffect, useState } from 'react'
import Avatar from '../../../components/Avatar'
import Button from '../../../components/Button'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import { formatHm } from '../timeline/format'
import { staffAvatarUrl } from '../../../lib/staffAvatars'
import {
  ApiError,
  getReassignCandidates,
  reassignBooking,
  type Candidate,
  type QueueItem,
} from './api'
import './reassign.css'

export interface ReassignSheetProps {
  item: QueueItem | null
  onClose: () => void
  /** Chuyển thành công — trang cha gỡ item khỏi hàng chờ ngay lập tức. */
  onReassigned: (itemId: number) => void
}

/**
 * Sheet "Chuyển kỹ thuật viên" (PRD §8, prototype `openReassign()` dòng
 * 950-983). Hai phát hiện từ prototype phải giữ nguyên (card, mục "Ngữ cảnh
 * cần biết"):
 *   1. Mỗi ứng viên không đủ điều kiện hiện NGUYÊN VĂN `reason` từ API bên
 *      dưới tên, không chỉ làm mờ nút im lặng.
 *   2. Không còn ai đủ điều kiện → Notice cảnh báo riêng kèm số điện thoại
 *      khách dạng `tel:`, không phải 4 nút xám không lối ra.
 */
export default function ReassignSheet({ item, onClose, onReassigned }: ReassignSheetProps) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reassigningId, setReassigningId] = useState<number | null>(null)

  useEffect(() => {
    if (item === null) {
      setCandidates(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setActionError(null)
    getReassignCandidates(item.item_id)
      .then((list) => {
        if (!cancelled) setCandidates(list)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Không tải được danh sách kỹ thuật viên. Vui lòng thử lại.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [item])

  async function handlePick(staffId: number) {
    if (item === null) return
    setReassigningId(staffId)
    setActionError(null)
    try {
      await reassignBooking(item.item_id, staffId)
      onReassigned(item.item_id)
    } catch (err) {
      if (err instanceof ApiError) {
        setActionError(err.message)
      } else {
        setActionError('Không chuyển được kỹ thuật viên. Vui lòng thử lại.')
      }
    } finally {
      setReassigningId(null)
    }
  }

  const noEligible = candidates !== null && candidates.every((c) => !c.eligible)
  const telHref = item?.customer_phone ? `tel:${item.customer_phone.replace(/\s/g, '')}` : null

  return (
    <Sheet
      open={item !== null}
      onClose={onClose}
      title="Chuyển kỹ thuật viên"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      {item && (
        <div data-testid="reassign-sheet">
          <div className="ccf-rq-summary" style={{ marginBottom: 18 }}>
            <div className="ccf-rq-sline">
              <span className="ccf-rq-k">Khách</span>
              <span className="ccf-rq-v">{item.customer_name}</span>
            </div>
            <div className="ccf-rq-sline">
              <span className="ccf-rq-k">Dịch vụ</span>
              <span className="ccf-rq-v">{item.service_name}</span>
            </div>
            <div className="ccf-rq-sline">
              <span className="ccf-rq-k">Giờ</span>
              <span className="ccf-rq-v">
                {formatHm(item.start_at)} – {formatHm(item.end_at)}
              </span>
            </div>
          </div>

          {loading && <p>Đang tải danh sách kỹ thuật viên...</p>}
          {loadError && <Notice tone="warn">{loadError}</Notice>}
          {actionError && (
            <Notice tone="warn" style={{ marginBottom: 12 }}>
              {actionError}
            </Notice>
          )}

          {noEligible && (
            <Notice tone="warn" data-testid="reassign-no-candidate-notice">
              <b>Không có ai nhận được khung giờ này.</b>
              <br />
              Gọi khách để đổi sang giờ khác, hoặc huỷ và xin lỗi khách.
              {telHref && (
                <div>
                  <a className="ccf-rq-tel" href={telHref} data-testid="reassign-call-customer">
                    📞 {item.customer_phone}
                  </a>
                </div>
              )}
            </Notice>
          )}

          {candidates && candidates.length > 0 && (
            <>
              <div className="ccf-rq-label" style={{ marginTop: 0 }}>
                Ai có thể nhận?
              </div>
              {candidates.map((c) => (
                <button
                  type="button"
                  key={c.staff.id}
                  data-testid={`reassign-candidate-${c.staff.id}`}
                  className="ccf-rq-candidate"
                  disabled={!c.eligible || reassigningId !== null}
                  onClick={() => handlePick(c.staff.id)}
                >
                  <Avatar name={c.staff.name} src={staffAvatarUrl(c.staff.name)} />
                  <div style={{ flex: 1 }}>
                    <div className="ccf-rq-nm">{c.staff.name}</div>
                    <div
                      className={`ccf-rq-why ${c.eligible ? 'ccf-rq-why--ok' : 'ccf-rq-why--no'}`}
                      data-testid={`reassign-reason-${c.staff.id}`}
                    >
                      {c.eligible ? 'Đủ kỹ năng · đang rảnh' : c.message}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </Sheet>
  )
}
