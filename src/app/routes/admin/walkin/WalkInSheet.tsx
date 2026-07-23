import { useEffect, useState } from 'react'
import Avatar from '../../../components/Avatar'
import Button from '../../../components/Button'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import { formatHm } from '../timeline/format'
import { staffAvatarUrl } from '../../../lib/staffAvatars'
import {
  ApiError,
  createWalkIn,
  getAvailableNow,
  getServices,
  type AvailableStaff,
  type Service,
} from './api'
import './walkin.css'

export interface WalkInFabProps {
  /** Gọi lại sau khi tạo khách vãng lai thành công, để trang cha refresh dữ liệu. */
  onCreated?: () => void
}

/**
 * FAB "+ Khách vãng lai" cố định góc màn hình + Sheet luồng
 * dịch vụ → gói → KTV rảnh ngay → tên/SĐT → "Bắt đầu phục vụ" (PRD §7).
 *
 * Bám đúng luồng prototype `openWalkIn()`/`drawWalkIn()` (dòng 856-911):
 * chọn dịch vụ trước, gói sau, rồi mới gọi available-now; không ai rảnh thì
 * hiện Notice cảnh báo thay vì danh sách rỗng im lặng.
 */
export default function WalkInFab({ onCreated }: WalkInFabProps) {
  const [open, setOpen] = useState(false)
  const [services, setServices] = useState<Service[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [serviceId, setServiceId] = useState<number | null>(null)
  const [variantId, setVariantId] = useState<number | null>(null)
  const [staffId, setStaffId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')

  const [availableStaff, setAvailableStaff] = useState<AvailableStaff[] | null>(null)
  const [availLoading, setAvailLoading] = useState(false)
  const [availError, setAvailError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const nowLabel = formatHm(Math.floor(Date.now() / 1000))

  function resetForm() {
    setServiceId(null)
    setVariantId(null)
    setStaffId(null)
    setName('')
    setPhone('')
    setAvailableStaff(null)
    setAvailError(null)
    setSaveError(null)
  }

  function openSheet() {
    resetForm()
    setOpen(true)
    if (services === null) {
      setLoadError(null)
      getServices()
        .then(setServices)
        .catch(() => setLoadError('Không tải được danh mục dịch vụ. Vui lòng thử lại.'))
    }
  }

  function closeSheet() {
    setOpen(false)
  }

  // Gọi available-now mỗi khi đã chọn gói xong — đúng bước 2 của luồng
  // "chọn dịch vụ → chọn gói → KTV rảnh ngay" (card, mục Việc phải làm #2).
  useEffect(() => {
    if (variantId === null) {
      setAvailableStaff(null)
      return
    }
    let cancelled = false
    setAvailLoading(true)
    setAvailError(null)
    setStaffId(null)
    getAvailableNow(variantId)
      .then((staff) => {
        if (!cancelled) setAvailableStaff(staff)
      })
      .catch(() => {
        if (!cancelled) setAvailError('Không tải được danh sách kỹ thuật viên rảnh. Vui lòng thử lại.')
      })
      .finally(() => {
        if (!cancelled) setAvailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [variantId])

  const selectedService = services?.find((s) => s.id === serviceId) ?? null
  const selectedVariant = selectedService?.variants.find((v) => v.id === variantId) ?? null

  function handleServiceChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setServiceId(id)
    setVariantId(null)
    setStaffId(null)
    setAvailableStaff(null)
  }

  function handleVariantChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setVariantId(id)
  }

  async function handleSave() {
    if (variantId === null || staffId === null) return
    setSaving(true)
    setSaveError(null)
    try {
      await createWalkIn({
        variantId,
        staffId,
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
      })
      setOpen(false)
      onCreated?.()
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err.message)
      } else {
        setSaveError('Không tạo được lượt phục vụ. Vui lòng thử lại.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button type="button" className="ccf-wi-fab" data-testid="walkin-fab" onClick={openSheet}>
        + Khách vãng lai
      </button>

      <Sheet
        open={open}
        onClose={closeSheet}
        title="Khách vãng lai"
        footer={
          <>
            <Button variant="ghost" onClick={closeSheet}>
              Đóng
            </Button>
            <Button
              data-testid="walkin-submit"
              disabled={staffId === null || saving}
              onClick={handleSave}
            >
              {saving ? 'Đang lưu...' : 'Bắt đầu phục vụ'}
            </Button>
          </>
        }
      >
        <div data-testid="walkin-sheet">
          {loadError && <Notice tone="warn">{loadError}</Notice>}

          {saveError && (
            <Notice tone="warn" style={{ marginBottom: 12 }}>
              {saveError}
            </Notice>
          )}

          <Notice tone="info" className="ccf-wi-now" data-testid="walkin-now-notice">
            Bắt đầu ngay bây giờ — <b>{nowLabel}</b>. Giờ bắt đầu không cần tròn 15 phút.
          </Notice>

          <Field
            as="select"
            label="Dịch vụ"
            data-testid="walkin-service-select"
            value={serviceId ?? ''}
            onChange={(e) => handleServiceChange(e.target.value)}
          >
            <option value="">— Chọn dịch vụ —</option>
            {services?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Field>

          {selectedService && (
            <Field
              as="select"
              label="Gói"
              data-testid="walkin-variant-select"
              value={variantId ?? ''}
              onChange={(e) => handleVariantChange(e.target.value)}
            >
              <option value="">— Chọn gói —</option>
              {selectedService.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Field>
          )}

          {selectedVariant && (
            <>
              <div className="ccf-wi-label">Kỹ thuật viên đang rảnh</div>
              {availLoading && <p>Đang tải...</p>}
              {availError && <Notice tone="warn">{availError}</Notice>}
              {!availLoading && !availError && availableStaff !== null && (
                <>
                  {availableStaff.length === 0 ? (
                    <Notice tone="warn" data-testid="walkin-no-staff-notice">
                      Không có ai rảnh cho dịch vụ này lúc này.
                    </Notice>
                  ) : (
                    availableStaff.map((s, i) => (
                      <button
                        type="button"
                        key={s.id}
                        data-testid={`walkin-staff-${s.id}`}
                        className={`ccf-wi-staffpick${staffId === s.id ? ' ccf-wi-staffpick--sel' : ''}`}
                        onClick={() => setStaffId(s.id)}
                      >
                        <Avatar name={s.name} src={staffAvatarUrl(s.name)} />
                        <div style={{ flex: 1 }}>
                          <div className="ccf-wi-nm">{s.name}</div>
                          <div className="ccf-wi-mt">{i === 0 ? 'Rảnh ngay · gợi ý' : 'Rảnh ngay'}</div>
                        </div>
                      </button>
                    ))
                  )}
                </>
              )}

              {availableStaff !== null && availableStaff.length > 0 && (
                <>
                  <div className="ccf-wi-label">Khách hàng</div>
                  <Field
                    label="Tên"
                    data-testid="walkin-name-input"
                    placeholder="Để trống nếu khách không muốn cho tên"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Field
                    label="Số điện thoại (không bắt buộc)"
                    type="tel"
                    inputMode="numeric"
                    data-testid="walkin-phone-input"
                    placeholder="0901 234 567"
                    hint="Bỏ trống sẽ lưu là “Khách lẻ”."
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </>
              )}
            </>
          )}
        </div>
      </Sheet>
    </>
  )
}
