import { useEffect, useState } from 'react'
import Button from '../../../components/Button'
import Card from '../../../components/Card'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import Pill from '../../../components/Pill'
import EmptyState from '../../../components/EmptyState'
import Sheet from '../../../components/Sheet'
import {
  createService,
  createVariant,
  getServices,
  getSkills,
  getVariants,
  updateService,
  updateVariant,
  type BodyZone,
  type Service,
  type ServiceVariant,
  type Skill,
} from './api'
import { BODY_ZONE_LABELS, formatVnd } from './format'

const BODY_ZONES: BodyZone[] = ['hair', 'hands', 'feet', 'face', 'body']

export interface ServicesTabProps {
  /** true khi tab này đang hiển thị — dùng để refetch danh sách kỹ năng mỗi
   * lần chuyển tới tab (skill có thể vừa được thêm ở tab Nhân viên). */
  active: boolean
}

export default function ServicesTab({ active }: ServicesTabProps) {
  const [services, setServices] = useState<Service[]>([])
  const [variants, setVariants] = useState<ServiceVariant[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [newSkillId, setNewSkillId] = useState<number | ''>('')
  const [newZone, setNewZone] = useState<BodyZone | ''>('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [editingService, setEditingService] = useState<Service | null>(null)

  const [variantName, setVariantName] = useState('')
  const [variantDuration, setVariantDuration] = useState('')
  const [variantBuffer, setVariantBuffer] = useState('')
  const [variantPrice, setVariantPrice] = useState('')
  const [variantError, setVariantError] = useState<string | null>(null)
  const [addingVariant, setAddingVariant] = useState(false)

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    try {
      const [serviceList, variantList, skillList] = await Promise.all([
        getServices(),
        getVariants(),
        getSkills(),
      ])
      setServices(serviceList)
      setVariants(variantList)
      setSkills(skillList)
    } catch {
      setLoadError('Không tải được danh sách. Vui lòng thử lại.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) getSkills().then(setSkills).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  function skillName(id: number): string {
    return skills.find((s) => s.id === id)?.name ?? '—'
  }

  async function handleAddService() {
    setAddError(null)
    const name = newName.trim()
    if (!name) {
      setAddError('Vui lòng nhập tên dịch vụ.')
      return
    }
    if (newSkillId === '') {
      setAddError('Vui lòng chọn kỹ năng cần thiết.')
      return
    }
    if (newZone === '') {
      setAddError('Vui lòng chọn vùng cơ thể.')
      return
    }
    setAdding(true)
    try {
      const created = await createService(name, newSkillId, newZone)
      setServices((prev) => [...prev, created])
      setNewName('')
      setNewSkillId('')
      setNewZone('')
    } catch {
      setAddError('Không thêm được dịch vụ. Vui lòng thử lại.')
    } finally {
      setAdding(false)
    }
  }

  async function handleToggleServiceActive(service: Service) {
    try {
      const updated = await updateService(service.id, { active: !service.active })
      setServices((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      setEditingService((prev) => (prev && prev.id === updated.id ? updated : prev))
    } catch {
      setLoadError('Không cập nhật được trạng thái dịch vụ.')
    }
  }

  function resetVariantForm() {
    setVariantName('')
    setVariantDuration('')
    setVariantBuffer('')
    setVariantPrice('')
    setVariantError(null)
  }

  async function handleAddVariant() {
    if (!editingService) return
    setVariantError(null)
    const name = variantName.trim()
    const duration = Number(variantDuration)
    const buffer = variantBuffer.trim() === '' ? 0 : Number(variantBuffer)
    const price = Number(variantPrice)

    if (!name) {
      setVariantError('Vui lòng nhập tên gói.')
      return
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      setVariantError('Thời lượng phải lớn hơn 0 phút.')
      return
    }
    if (!Number.isFinite(buffer) || buffer < 0) {
      setVariantError('Thời gian dọn dẹp không được âm.')
      return
    }
    if (!Number.isFinite(price) || price < 0) {
      setVariantError('Giá không được âm.')
      return
    }

    setAddingVariant(true)
    try {
      const created = await createVariant({
        service_id: editingService.id,
        name,
        duration_min: Math.round(duration),
        buffer_after_min: Math.round(buffer),
        price: Math.round(price),
      })
      setVariants((prev) => [...prev, created])
      resetVariantForm()
    } catch {
      setVariantError('Không thêm được gói. Vui lòng thử lại.')
    } finally {
      setAddingVariant(false)
    }
  }

  async function handleToggleVariantActive(variant: ServiceVariant) {
    try {
      const updated = await updateVariant(variant.id, { active: !variant.active })
      setVariants((prev) => prev.map((v) => (v.id === updated.id ? updated : v)))
    } catch {
      setVariantError('Không cập nhật được trạng thái gói.')
    }
  }

  if (loading) {
    return <p>Đang tải...</p>
  }

  const editingVariants = editingService ? variants.filter((v) => v.service_id === editingService.id) : []

  return (
    <div>
      {loadError && <Notice tone="warn">{loadError}</Notice>}

      <section className="ccf-su-section">
        <h2>Thêm dịch vụ</h2>
        {addError && <Notice tone="warn">{addError}</Notice>}
        <Field
          label="Tên dịch vụ"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Ví dụ: Massage toàn thân"
          data-testid="service-name-input"
        />
        <Field
          as="select"
          label="Kỹ năng cần thiết"
          value={newSkillId}
          onChange={(e) => setNewSkillId(e.target.value ? Number(e.target.value) : '')}
          data-testid="service-skill-select"
        >
          <option value="">— Chọn kỹ năng —</option>
          {skills.map((sk) => (
            <option key={sk.id} value={sk.id}>
              {sk.name}
            </option>
          ))}
        </Field>
        <Field
          as="select"
          label="Vùng cơ thể"
          value={newZone}
          onChange={(e) => setNewZone(e.target.value as BodyZone | '')}
          data-testid="service-zone-select"
        >
          <option value="">— Chọn vùng —</option>
          {BODY_ZONES.map((z) => (
            <option key={z} value={z}>
              {BODY_ZONE_LABELS[z]}
            </option>
          ))}
        </Field>
        <Button onClick={handleAddService} disabled={adding} data-testid="service-add-submit">
          {adding ? 'Đang thêm...' : 'Thêm dịch vụ'}
        </Button>
      </section>

      <section className="ccf-su-section">
        <h2>Danh sách dịch vụ</h2>
        {services.length === 0 ? (
          <EmptyState icon="🧴" text="Chưa có dịch vụ nào." />
        ) : (
          <div data-testid="service-list">
            {services.map((s) => (
              <Card key={s.id} data-testid={`service-row-${s.id}`} onClick={() => setEditingService(s)}>
                <div className="ccf-su-row">
                  <div className="ccf-su-row-main">
                    <div className="ccf-su-row-title">{s.name}</div>
                    <div className="ccf-su-row-sub">
                      {skillName(s.skill_id)} · {BODY_ZONE_LABELS[s.body_zone] ?? s.body_zone}
                    </div>
                  </div>
                  <Pill tone={s.active ? 'default' : 'gray'} data-testid={`service-status-${s.id}`}>
                    {s.active ? 'Đang bán' : 'Ngưng'}
                  </Pill>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Sheet
        open={editingService !== null}
        onClose={() => {
          setEditingService(null)
          resetVariantForm()
        }}
        title={editingService?.name ?? ''}
        footer={
          <Button variant="ghost" onClick={() => setEditingService(null)}>
            Đóng
          </Button>
        }
      >
        {editingService && (
          <div data-testid="service-edit-sheet">
            <div className="ccf-su-toggle-row">
              <span>Trạng thái</span>
              <Button
                variant={editingService.active ? 'ghost' : 'primary'}
                size="sm"
                data-testid="service-toggle-active"
                onClick={() => handleToggleServiceActive(editingService)}
              >
                {editingService.active ? 'Ngưng bán' : 'Bán lại'}
              </Button>
            </div>

            <div className="ccf-su-label">Gói của dịch vụ này</div>
            {editingVariants.length === 0 ? (
              <p className="ccf-su-hint">Chưa có gói nào.</p>
            ) : (
              <div data-testid="variant-list">
                {editingVariants.map((v) => (
                  <div key={v.id} className="ccf-su-variant-row" data-testid={`variant-row-${v.id}`}>
                    <div className="ccf-su-row-main">
                      <div className="ccf-su-row-title">{v.name}</div>
                      <div className="ccf-su-row-sub">
                        {v.duration_min} phút · dọn dẹp {v.buffer_after_min} phút · {formatVnd(v.price)}
                      </div>
                    </div>
                    <Button
                      variant={v.active ? 'ghost' : 'primary'}
                      size="sm"
                      data-testid={`variant-toggle-${v.id}`}
                      onClick={() => handleToggleVariantActive(v)}
                    >
                      {v.active ? 'Ngưng' : 'Bán lại'}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="ccf-su-label" style={{ marginTop: 18 }}>
              Thêm gói mới
            </div>
            {variantError && <Notice tone="warn" data-testid="variant-error">{variantError}</Notice>}
            <Field
              label="Tên gói"
              value={variantName}
              onChange={(e) => setVariantName(e.target.value)}
              placeholder="Ví dụ: 60 phút"
              data-testid="variant-name-input"
            />
            <Field
              label="Thời lượng (phút)"
              type="number"
              inputMode="numeric"
              min={1}
              value={variantDuration}
              onChange={(e) => setVariantDuration(e.target.value)}
              data-testid="variant-duration-input"
            />
            <Field
              label="Thời gian dọn dẹp sau (phút)"
              type="number"
              inputMode="numeric"
              min={0}
              value={variantBuffer}
              onChange={(e) => setVariantBuffer(e.target.value)}
              data-testid="variant-buffer-input"
            />
            <Field
              label="Giá (đ)"
              type="number"
              inputMode="numeric"
              min={0}
              value={variantPrice}
              onChange={(e) => setVariantPrice(e.target.value)}
              data-testid="variant-price-input"
            />
            <Button onClick={handleAddVariant} disabled={addingVariant} data-testid="variant-add-submit">
              {addingVariant ? 'Đang thêm...' : 'Thêm gói'}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  )
}
