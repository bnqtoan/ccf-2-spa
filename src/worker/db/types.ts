// Types matching migrations/0001_init.sql (PRD §3.2).
//
// All timestamps are UTC epoch seconds. Exception: WorkShift.start_min/end_min
// are minutes-from-local-midnight (0..1440) — see CONVENTIONS §1.
// SQLite has no boolean type: `active` columns are stored as INTEGER 0/1.

export type AppointmentStatus = 'booked' | 'in_service' | 'done' | 'cancelled' | 'no_show'
export type BookingItemStatus = AppointmentStatus
export type AppointmentSource = 'online' | 'walk_in' | 'admin'
export type BodyZone = 'hair' | 'hands' | 'feet' | 'face' | 'body'

export interface Skill {
  id: number
  name: string
}

export interface Staff {
  id: number
  name: string
  phone: string | null
  active: number
}

export interface StaffSkill {
  staff_id: number
  skill_id: number
}

export interface Service {
  id: number
  name: string
  skill_id: number
  body_zone: BodyZone
  active: number
}

export interface ServiceVariant {
  id: number
  service_id: number
  name: string
  duration_min: number
  buffer_after_min: number
  price: number
  active: number
}

export interface WorkShift {
  id: number
  staff_id: number
  weekday: number // 0..6
  start_min: number // minutes from local midnight, 0..1440
  end_min: number // minutes from local midnight, 0..1440
}

export interface TimeOff {
  id: number
  staff_id: number
  start_at: number
  end_at: number
  reason: string | null
}

export interface Customer {
  id: number
  name: string
  phone: string | null
}

export interface Appointment {
  id: number
  customer_id: number
  start_at: number
  end_at: number
  status: AppointmentStatus
  source: AppointmentSource
  created_at: number
}

export interface BookingItem {
  id: number
  appointment_id: number
  staff_id: number
  variant_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: BookingItemStatus
  cancelled_at: number | null
}
