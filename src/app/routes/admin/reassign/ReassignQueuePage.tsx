import { useEffect, useState } from 'react'
import Button from '../../../components/Button'
import EmptyState from '../../../components/EmptyState'
import Notice from '../../../components/Notice'
import Pill from '../../../components/Pill'
import WalkInFab from '../walkin/WalkInSheet'
import { formatHm } from '../timeline/format'
import { ApiError, cancelBooking, getReassignQueue, type QueueItem } from './api'
import ReassignSheet from './ReassignSheet'
import './reassign.css'

/**
 * Màn "Hàng chờ xếp lại" (PRD §8). Mỗi khách mồ côi có 3 hành động: gọi điện
 * (`tel:`), chuyển KTV (mở ReassignSheet), huỷ lịch. Rỗng → EmptyState.
 *
 * FAB "+ Khách vãng lai" (T-13 phạm vi trong) sống chung màn này — card yêu
 * cầu "hiện trên mọi màn admin"; T-13 chỉ được đụng touches của mình
 * (`routes/admin/walkin/`, `routes/admin/reassign/`), nên nhúng ở đây thay vì
 * sửa TimelinePage.tsx (thuộc T-12, ngoài touches).
 */
export default function ReassignQueuePage() {
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<QueueItem | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const list = await getReassignQueue()
      setItems(list)
    } catch {
      setError('Không tải được hàng chờ. Vui lòng thử lại.')
    }
  }

  useEffect(() => {
    load()
  }, [])

  function handleReassigned(itemId: number) {
    setItems((prev) => (prev === null ? prev : prev.filter((i) => i.item_id !== itemId)))
    setSelectedItem(null)
  }

  async function handleCancel(item: QueueItem) {
    if (!confirm(`Huỷ lịch của ${item.customer_name}?\n\nNhớ gọi báo khách trước.`)) return
    setCancellingId(item.item_id)
    setActionError(null)
    try {
      await cancelBooking(item.item_id)
      setItems((prev) => (prev === null ? prev : prev.filter((i) => i.item_id !== item.item_id)))
    } catch (err) {
      if (err instanceof ApiError) {
        setActionError(err.message)
      } else {
        setActionError('Không huỷ được lịch. Vui lòng thử lại.')
      }
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <div className="ccf-rq-page">
      <div className="ccf-rq-title">Hàng chờ xếp lại</div>

      {error && <Notice tone="warn">{error}</Notice>}
      {actionError && (
        <Notice tone="warn" style={{ marginBottom: 12 }}>
          {actionError}
        </Notice>
      )}

      {items !== null && items.length === 0 && (
        <EmptyState icon="✓" text="Không còn lịch nào cần xếp lại." />
      )}

      {items?.map((item) => (
        <div className="ccf-rq-item" key={item.item_id} data-testid={`queue-item-${item.item_id}`}>
          <div className="ccf-rq-h">
            <div>
              <div className="ccf-rq-w">
                {formatHm(item.start_at)} · {item.customer_name}
              </div>
              <div className="ccf-rq-d">
                {item.service_name}
                {item.customer_phone ? ` · ${item.customer_phone}` : ''}
              </div>
            </div>
            <Pill tone="red">Chưa xử lý</Pill>
          </div>
          <div className="ccf-rq-a">
            {item.customer_phone && (
              <a
                className="ccf-btn ccf-btn--ghost ccf-btn--sm"
                href={`tel:${item.customer_phone.replace(/\s/g, '')}`}
                data-testid={`queue-call-${item.item_id}`}
              >
                📞 Gọi khách
              </a>
            )}
            <Button
              variant="primary"
              size="sm"
              data-testid={`queue-reassign-${item.item_id}`}
              onClick={() => setSelectedItem(item)}
            >
              Chuyển kỹ thuật viên
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid={`queue-cancel-${item.item_id}`}
              disabled={cancellingId === item.item_id}
              onClick={() => handleCancel(item)}
            >
              Huỷ lịch
            </Button>
          </div>
        </div>
      ))}

      <ReassignSheet item={selectedItem} onClose={() => setSelectedItem(null)} onReassigned={handleReassigned} />

      <WalkInFab onCreated={load} />
    </div>
  )
}
