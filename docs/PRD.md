# PRD — Spa Booking (ccf-2-spa)

Audience: AI agents implementing this. Terse by design.

## 1. Scope

Booking system for a spa. Customers book services; system assigns technicians
(KTV) who have the required skill and are free. No auth in v1 — anyone can
reach both the customer UI and the admin UI.

**In (MVP)**
- CRUD: skills, staff (+skills), services (+variants), work shifts
- Staff time-off / block time
- Buffer (cleanup) time after each service
- Customer booking flow: pick service variant → date → slot → (auto or chosen KTV)
- Cancel booking → frees the KTV's slot; 2-hour cutoff on the customer UI
- Walk-in quick booking (receptionist, Admin UI)
- Reassign queue: bookings orphaned by a sudden staff absence
- Admin: day view of all staff schedules, manual create/cancel/reassign

**Out (v2)**
- Rooms/beds as a constrained resource
- Multi-branch
- Customer-facing combo booking UI (schema supports it; v1 admin adds items manually)
- Deposits / no-show fees
- Auth, payments, notifications, reviews, recurring appointments

No `room_id` or `branch_id` columns are added "in advance". Unused nullable
columns are a lie that the feature was designed for — the v2 migration paths
in §10 are cheaper and honest.

## 2. Decisions (locked)

| Topic | Decision |
|---|---|
| Assignment | Auto-assign by default; customer may request a specific KTV |
| Service model | Service → many Variants (duration/price/buffer per variant) |
| Start grid | 15 minutes |
| Duration | Free-form per variant (45', 90', …), not slot-count based |
| Stack | Cloudflare Workers + D1 + Hono API + React SPA (Vite) |
| Concurrency | D1 transaction + overlap re-check before commit |
| Cancellation | Customer self-cancel ≥2h before start; below that, contact desk. Admin unrestricted |
| Walk-ins | First-class appointments created by the receptionist, never `time_off` |
| Staff absence | `time_off` + a reassign queue for the bookings it orphans |
| Rooms | Deferred, no reserved column |
| Multi-branch | Deferred, no reserved column; see §10 |
| Auth | None in v1 |

## 3. Domain model

### 3.1 Core rule

A technician is occupied for `[start_at, block_end_at)` where
`block_end_at = start_at + variant.duration_min + variant.buffer_after_min`.

`end_at` (= `start_at + duration_min`) is display-only, shown to the customer.
**Every availability query uses `block_end_at`, never `end_at`.** Keeping the
two columns separate is what stops buffer from being silently dropped in a join.

### 3.2 Tables

```sql
skills           (id, name)
staff            (id, name, phone, active)
staff_skills     (staff_id, skill_id)             -- PK (staff_id, skill_id)

services         (id, name, skill_id, body_zone, active)
service_variants (id, service_id, name, duration_min, buffer_after_min,
                  price, active)

work_shifts      (id, staff_id, weekday, start_min, end_min)
                 -- weekday 0..6; minutes from midnight; repeats weekly
time_off         (id, staff_id, start_at, end_at, reason)
                 -- ad-hoc absence, lunch, personal block

customers        (id, name, phone)                -- identified by phone, no login
                 -- phone nullable: anonymous walk-ins are stored as name only

appointments     (id, customer_id, start_at, end_at, status, source, created_at)
                 -- one customer visit; spans all its items
                 -- source ∈ online | walk_in | admin
booking_items    (id, appointment_id, staff_id, variant_id,
                  start_at, end_at, block_end_at, status, cancelled_at)
                 -- one row = one technician occupied for one interval
```

`appointments` / `booking_items` are split from day one even though v1's
customer UI only creates single-item appointments. A single booking is simply
an appointment with exactly one item — no added complexity — and the split
avoids a painful migration when combos ship in v2.

All timestamps are stored as **UTC epoch seconds (INTEGER)**. The spa's local
timezone is a single app-level constant (Asia/Ho_Chi_Minh); conversion happens
at the API boundary, never in the DB.

### 3.3 Status

`booked → in_service → done`, with `cancelled` and `no_show` as terminal exits
from `booked`.

| Status | Occupies the technician? | Meaning |
|---|---|---|
| `booked` | yes | Scheduled, not started |
| `in_service` | yes | Customer is in the chair right now |
| `cancelled` | no | Cancelled by customer or desk |
| `no_show` | no | Customer never arrived |
| `done` | no | Completed |

Rows are never deleted — cancelling sets the status and stamps `cancelled_at`.
Availability counts only `booked` and `in_service`.

`no_show` is **reporting and phone-reputation data, not a slot-recovery
mechanism**. By the time the desk marks it (15–20 min past the start time) the
slot has already burned; nobody can rebook it. Do not build recovery logic on
this transition.

### 3.4 body_zone

`services.body_zone` ∈ `hair | hands | feet | face | body`.

Only meaningful for parallel items within one appointment: two items that
overlap in time are valid **only if their services have different
`body_zone`s**. Hair + nails ✅. Body massage + hair wash ❌. Unused for
single-item appointments, which is all of v1's customer flow.

## 4. Availability algorithm

Input: `variant_id`, `date`, optional `preferred_staff_id`.

```
1. Load variant → duration_min, buffer_after_min, service.skill_id
   block = duration_min + buffer_after_min
2. candidates = active staff having skill_id
   if preferred_staff_id: narrow to that one
3. for each candidate:
   a. work_shifts for that weekday → working window(s)
   b. subtract time_off intervals intersecting the day
   c. subtract booking_items where status IN ('booked','in_service'),
      using [start_at, block_end_at)
   → list of free intervals
   d. walk the 15-minute grid inside each free interval; keep t if
      [t, t + block) fits entirely within that free interval
4. Group by time: each distinct t → list of staff available at t
5. Return slots [{ start_at, staff_ids[] }]
```

Frontend shows the times; the KTV list per slot only surfaces when the
customer wants to choose. Auto-assign picks from `staff_ids` by **fewest
booked minutes that day** (load balancing), ties broken by staff id for
determinism.

Complexity is trivial at spa scale (<20 staff, one day, 15-min grid) — brute
force over the grid is correct and fast. Do not optimize prematurely.

## 5. Booking write path

```
BEGIN
  re-run availability for (variant, start_at, staff_id)   -- authoritative check
  if not available: ROLLBACK → 409 SLOT_TAKEN
  insert appointment
  insert booking_item(s)
COMMIT
```

The client's earlier availability response is advisory only; the transaction's
re-check is the sole source of truth. Two customers racing for the last slot
means one gets a 409 and the UI refreshes the slot list.

Cancellation: set `status='cancelled'`, stamp `cancelled_at`. The slot becomes
available again immediately — no other bookkeeping, because availability is
always computed from live `booking_items`, never from a materialized calendar.

## 6. Cancellation policy

`CANCEL_CUTOFF_MIN = 120`, an app constant.

- **≥120 min before start** — customer self-cancels on the web; slot frees
  instantly.
- **<120 min** — the customer endpoint returns 409 `CANCEL_TOO_LATE`. The UI
  replaces the cancel button with the spa's phone number.
- **Admin** — cancels at any time, no cutoff. The desk is trusted.

The cutoff exists for a commercial reason, not a technical one: forcing a
last-minute cancellation through a phone call gives the receptionist a chance
to **reschedule instead of losing the slot**. A self-serve button at T-20min
converts a salvageable appointment into an empty chair. Enforce the cutoff
server-side — hiding the button alone is not a policy.

No-show fees and deposits are v2 and require payments first.

## 7. Walk-ins

30–50% of spa traffic arrives without an appointment. Walk-ins are **real
appointments** (`source='walk_in'`), never `time_off`. Modelling them as
time-off would erase revenue, service history, and the customer record — the
exact data the business runs on.

Receptionist flow (Admin UI → Quick Booking):
1. Pick variant → system shows technicians free *right now*
2. Pick technician
3. Customer identity: existing phone, or name+phone, or "Khách lẻ" (anonymous —
   a customer row with `phone = NULL`)
4. Create appointment, `status='in_service'`, `start_at = now`

The technician is marked busy immediately, so an online customer cannot grab
the same interval seconds later.

**`start_at` for walk-ins is exempt from the 15-minute grid.** Walk-ins start
whenever the customer arrives. Applying the grid rule here would reject every
real walk-in; the rule exists to keep the *bookable* calendar tidy, and a
walk-in is not bookable — it already happened.

## 8. Sudden staff absence & reassignment

Creating `time_off` that overlaps existing bookings must never silently orphan
them. The desk creates the time-off, and the API responds with the affected
items rather than refusing:

```
POST /api/admin/time-off
  → 200 { time_off, affected_items: [...] }   -- created, conflicts surfaced
```

Affected items keep `status='booked'` and their original `staff_id`, but the
admin day view lists them in a **Reassign queue** until each is either moved to
another technician or cancelled. They stay visible and actionable — an
unresolved queue is the point, since a real person must call each customer.

`POST /api/admin/bookings/:id/reassign` validates the new technician exactly
like a fresh booking (skill, shift, overlap), so reassignment cannot create the
double-booking it is meant to fix.

## 9. API surface (Hono)

```
GET    /api/services                      -- with nested active variants
GET    /api/availability?variant_id&date[&staff_id]
POST   /api/bookings                      -- {customer:{name,phone}, variant_id,
                                              start_at, staff_id?}
GET    /api/bookings?phone=               -- customer looks up own bookings
POST   /api/bookings/:id/cancel

-- admin (same app, no auth in v1)
GET    /api/admin/schedule?date=          -- all staff, all items, day view
GET    /api/admin/available-now?variant_id  -- walk-in: who is free right now
POST   /api/admin/walk-ins                -- quick booking, starts now
GET    /api/admin/reassign-queue          -- items orphaned by time-off
POST   /api/admin/bookings/:id/reassign   -- move item to another staff
POST   /api/admin/bookings/:id/status     -- in_service | done | no_show
CRUD   /api/admin/{skills,staff,services,variants,shifts,time-off}
POST   /api/admin/appointments/:id/items  -- manual combo item
```

Errors return `{ error: { code, message } }`. Codes that matter:
`SLOT_TAKEN`, `CANCEL_TOO_LATE`, `STAFF_LACKS_SKILL`, `OUTSIDE_SHIFT`,
`ZONE_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, `VALIDATION`.

## 10. Frontend (React SPA)

**Customer**: service list → variant → date picker → slot grid (times, with
optional "choose technician") → name + phone → confirm. Lookup page by phone
to view/cancel; inside the 2h cutoff the cancel button becomes the spa's phone
number.

**Admin**: day timeline, one column per staff, blocks rendered from
`booking_items` (buffer shown as a lighter tail so the reason for a gap is
visible). Persistent **Quick Booking** button for walk-ins. A **Reassign queue**
banner appears whenever orphaned items exist and does not dismiss until the
queue is empty. Side panels for CRUD on
skills/staff/services/variants/shifts/time-off.

Single SPA served by the Worker; `/admin/*` is just a route, unguarded in v1.

## 11. Validation rules

- `start_at` must land on the 15-minute grid — **except `source='walk_in'`**
- Assigned staff must have the service's skill
- The whole `[start_at, block_end_at)` must fit inside one work shift
- No overlap with the staff's `time_off` or their `booked`/`in_service` items
- Within one appointment, overlapping items must have distinct `body_zone`s
- Cannot book in the past (walk-ins start at `now`, which is not the past)
- Status transitions must follow §3.3; re-cancelling is `INVALID_TRANSITION`
- Customer cancel below `CANCEL_CUTOFF_MIN` → `CANCEL_TOO_LATE`; admin exempt

## 12. v2 migration paths

Recorded so v1 stays clean instead of carrying unused columns.

**Multi-branch.** Add `branches`, then put `branch_id` on **`work_shifts`**, not
on `staff`. A shift is what actually binds a person to a place at a time, so
technicians who rotate between locations — common in Vietnamese spa chains —
are ordinary data rather than an exception needing a join table bolted on later.
Availability then filters candidates by "has a shift at this branch on this
day". `appointments` also gets `branch_id`, denormalised for reporting.

**Rooms.** Add `rooms (id, branch_id, name)` and
`booking_items.room_id`. Availability gains a second constraint dimension:
a slot needs a free technician **and** a free room.

**Deposits / no-show fees.** Requires payments. `no_show` already carries the
phone-reputation signal these policies would price off.

## 13. Open questions

- Does a walk-in that finds no free technician get queued (a waitlist), or is
  it simply turned away? v1 turns away.
- Should repeated `no_show` on a phone number block online booking? The data
  supports it; the policy is undecided.
