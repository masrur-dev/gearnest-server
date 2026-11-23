# GearNest API Reference

Base URL (local): `http://localhost:5000`
All responses are JSON: `{ "success": boolean, ... }`.

## Conventions

- **Auth:** `Authorization: Bearer <JWT>` (JWT from `GET /api/auth/token` with a Better Auth session cookie).
- **Errors:** `401` missing/invalid/expired token · `403` wrong role · `404` not found · `409` conflict · `400` validation · `503` not configured.
- Roles: `Customer` (default), `Owner`, `Admin` — always read server-side from MongoDB.

---

## Health & session

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | – | Liveness |
| GET | `/api/health` | – | Health + uptime |
| GET | `/api/me` | session cookie **or** JWT | Current user (Better Auth session first, JWT fallback) |

## Better Auth (`/api/auth/*`)

Handled by Better Auth itself (registered before `express.json`): `sign-up/email`, `sign-in/email`, `sign-out`, `get-session`, `jwks`, `token`, `forget-password`, etc.
- Sign-up assigns `role: "Customer"` (server default; client cannot set `role`).
- Rate limited: 100 requests / 15 min.

## Profile — `/api/users`

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| GET | `/api/users/me` | any JWT | – |
| PATCH | `/api/users/me` | any JWT | only `name`, `image`, `phone`, `address` |

`email`, `role`, `password`, `createdAt` are rejected (`400`) if sent.

## Public equipment — `/api/equipment`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/equipment` | – | **Approved only.** Query: `search` (name/location), `category`, `rentalType` (Daily/Weekly/Monthly), `availability` (`available`\|`unavailable`), `minPrice`, `maxPrice`, `sort` (`newest`\|`price_asc`\|`price_desc`), `page` (positive integer), `limit` (positive integer, capped at 50). Malformed or repeated `page`/`limit` values return `400`. Returns `count,total,page,limit,pages,data`. |
| GET | `/api/equipment/:id` | – | Approved only; `400` on malformed id. |

## Owner equipment — `/api/owner` (JWT + role `Owner`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/owner/equipment` | Creates with `status:"pending"`; `ownerId/ownerName/ownerEmail` from token. Body: `name, description, category, location, rentalPrice, rentalType, availableQuantity, condition, brand, model, image, rentalTerms`. |
| GET | `/api/owner/equipment` | Own listings (excludes `removed`). |
| GET | `/api/owner/equipment/:id` | Own listing only (`404` otherwise). |
| PATCH | `/api/owner/equipment/:id` | Partial body merged with stored doc. Editing an **approved** listing resets it to `pending` (`reapprovalRequestedAt` set). Client cannot change `owner*`/`status`. |
| DELETE | `/api/owner/equipment/:id` | Soft delete (`status:"removed"`). `409` if the item has `pending_payment/confirmed/active` bookings. |

Categories: `Construction, Photography, Transportation, Agriculture, Electronics, Events` · Conditions: `New, Excellent, Good, Fair` · Types: `Daily, Weekly, Monthly`.

## Admin approvals — `/api/admin/approvals` (JWT + role `Admin`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/equipment` | Query `status=pending`(default)\|`approved`\|`rejected`\|`removed`\|`all`. |
| GET | `/equipment/:id` | Any listing (audit view). |
| PATCH | `/equipment/:id` | Body `{status:"approved"\|"rejected", reason?}`. Only `pending` items can be reviewed → duplicate approval/rejection returns `409`. Stores `reviewedBy`, `reviewedAt`, `rejectionReason` (required on reject, ≤500 chars), and appends `reviewHistory[]`. |

## Admin users — `/api/admin` (JWT + role `Admin`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users` | Query `search` (name/email), `role`, `page` (positive integer), `limit` (positive integer, capped at 100). Malformed or repeated `page`/`limit` values return `400`. |
| GET | `/users/:id` | Single user (public projection, no hashes). |
| PATCH | `/users/:id/role` | Body `{role: Customer\|Owner\|Admin}`. `403` on self-change; `409` if it would demote the last Admin. |
| GET | `/bookings` | **All bookings, platform-wide.** Query `status` (any booking status), `search` (equipment/customer/owner name or customer email), `limit` (max 100, default 100). Returns `count,total,page`-less payload: `{success,count,total,data[]}` with the same public booking projection as `/api/bookings`. |

### Role management — `/api/admin/role-management` (JWT + role `Admin`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users` | All users (id, name, email, role). |
| PATCH | `/users/:id/role` | Only `Customer`↔`Owner`. Refuses Admin accounts and self-modification. Optimistic concurrency (`409` if changed concurrently). |

## Bookings — `/api/bookings`

Pricing is **always computed server-side** (`config/pricing.js`): `rentalPrice` = one unit for one `rentalType` period; inclusive calendar days; Weekly = ceil(days/7) units, Monthly = ceil(days/30); max 365 days.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/` | Customer | Body `{equipmentId, quantity, startDate, endDate}` (YYYY-MM-DD). Creates `pending_payment` booking inside a MongoDB transaction (availability re-checked under transaction → no overselling). `409` if dates conflict or stock is short. |
| GET | `/` | any | Own bookings. Optional `?status=pending_payment\|confirmed\|active\|completed\|cancelled\|expired\|refunded` (`400` on invalid). Lazily expires unpaid bookings older than 30 min and advances `confirmed→active→completed`. |
| GET | `/owner/requests` | Owner | Bookings on own equipment; same optional `?status` filter. |
| GET | `/:id` | customer / equipment owner / Admin | `403` for anyone else. Projection exposes `paymentStatus` (`pending`/`paid`/`failed`/`refunded`/`null`) and `paidAt`. |
| POST | `/:id/cancel` | booking customer (or Admin) | Only `pending_payment` or `confirmed` → `cancelled`. `409` otherwise. **Auto-refund:** a paid booking is refunded via Stripe (`refunded: true`, message `…and refunded`); an unpaid one has its open Checkout Session expired (payment history → `expired`). |
| POST | `/:id/decline` | equipment Owner | Same eligible statuses → `cancelled`, with the same auto-refund / session-expiry behaviour as cancel. |
| POST | `/:id/complete` | equipment Owner | `confirmed`/`active` → `completed`. |

Booking states: `pending_payment → confirmed → active → completed`, plus `cancelled`, `expired`, `refunded`.
Unpaid holds: 30 minutes (`pending_payment` TTL), then auto-`expired`, releasing the dates.
The dashboards run the same lifecycle before aggregating, so their counts always reflect the real state.

## Payments — `/api/payments`

Requires `STRIPE_SECRET_KEY` (test mode); otherwise `503`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/create-checkout-session` | Customer | Body `{bookingId}` (own, `pending_payment`, unexpired, amount ≥ 50¢). Amount = stored `totalAmount × 100` cents; `mode: "payment"`; `client_reference_id` + `metadata.bookingId` = booking id; success/cancel URLs from `CLIENT_URL`. Reuses an open session when amount/currency match. Before replacing an unusable open session, the server verifies that Stripe retired it; if that cannot be confirmed it returns `503` without creating another session. **`409` if the stored session already `complete`** — a second charge is never started. Stores `stripeSessionId` on the booking and upserts a `payment` doc (`status: pending`). Returns `{success, bookingId, url}`. |
| POST | `/webhook` | Stripe signature | **Raw body** (mounted before `express.json`). `503` until `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` are set; `400` on missing/forged signature. Accepts `checkout.session.completed`/`async_payment_succeeded`/`async_payment_failed`/`expired` and `charge.refunded`. Requires `metadata.bookingId`, `client_reference_id` match, `mode: "payment"`. Idempotent by `stripeEventId` (redelivery → `{received:true, duplicate:true}`); a `400`/`500` answer releases the marker so Stripe's retry can be processed. **Paid sessions go through one settlement decision point:** confirm the booking (`outcome: confirmed`), supersede a stale session (`confirmed_stale_session`), ignore a repeat settlement (`already_settled`), **auto-refund** a duplicate session (`duplicate_refunded` / `duplicate_refund_failed`) or a late payment on a cancelled/expired booking (`late_refunded` / `late_refund_failed`); unverifiable paid sessions are logged `RECONCILIATION` (`reconciliation`). Failed/expired events keep the strict session/amount check. Returns `{received:true, outcome}`. |
| GET | `/session/:sessionId` | JWT (owner of payment) | Server-side truth for the success page — never trust the redirect. Returns `paymentStatus`, `bookingStatus`. When Stripe reports the session `paid`, the same settlement logic runs here too, so a delayed webhook can never leave a paid booking stuck. |
| GET | `/history` | any JWT | Own payment records. |

## Favorites — `/api/favorites` (JWT)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Own favorites joined with equipment. |
| POST | `/:equipmentId` | Approved equipment only; idempotent upsert. |
| DELETE | `/:equipmentId` | `404` if not a favorite. |

## Reviews — `/api/reviews`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/equipment/:equipmentId` | – | Approved equipment only. Returns `averageRating`, `count`, list. |
| POST | `/` | Customer | Body `{equipmentId, bookingId, rating(1–5 int), comment?}`. Eligibility: own booking, status `completed`, one review per booking (unique index → `409`). |
| DELETE | `/:id` | review owner or Admin | – |

## Dashboards — `/api/dashboard` (all real MongoDB aggregations)

| Method | Path | Role | Returns |
| --- | --- | --- | --- |
| GET | `/me` | any | `req.user` |
| GET | `/customer` | Customer | bookings by status, active/upcoming rentals, favorites, total paid, recent bookings |
| GET | `/owner` | Owner | equipment by status, requests by status, active/completed rentals, total earnings, 6-month revenue |
| GET | `/admin` | Admin | users by role, equipment by status, pending approvals, bookings by status, paid payment volume, 6-month signups |

---

## Client ↔ API contract map (gearnest-client)

Every frontend consumer and the endpoint it depends on. Verified against
the client source in `gearnest-client/src`.

### Auth & session

| Client | Endpoint(s) | Notes |
| --- | --- | --- |
| `lib/session.ts` (server) | `GET /api/auth/token` → `GET /api/dashboard/me` | Cookie → JWT → `{user:{id,name,email,role}}`; role gate for all dashboard routes. |
| `lib/api.ts` `authFetch` | any | Attaches `Authorization: Bearer <JWT>` from `authClient.token()`. |
| `lib/payments.ts` `startCheckout` | `POST /api/payments/create-checkout-session` | Expects `{success,url}`; only `https://checkout.stripe.com` URLs are opened. |
| `lib/payments.ts` `fetchSessionStatus` | `GET /api/payments/session/:sessionId` | `{paymentStatus, bookingStatus}` — source of truth for the success page. |
| Navbar, `use-dashboard-me` | `GET /api/dashboard/me` | Live session/role indicator. |

### Public pages

| Client page | Endpoint(s) | Notes |
| --- | --- | --- |
| `app/page.tsx` (home) | `GET /api/equipment` | Featured listings. |
| `app/equipment/page.tsx` | `GET /api/equipment?search&category&rentalType&availability&minPrice&maxPrice&sort&page&limit` | Server-side search/filter/sort/pagination. |
| `app/equipment/[id]/page.tsx` | `GET /api/equipment/:id` | Detail; `404`-state on failure. |
| `components/equipment/BookingForm` | `GET /api/bookings`, `POST /api/bookings`, `POST /api/payments/create-checkout-session`, `POST /api/bookings/:id/cancel` | Pending-hold resume, conflict detection, checkout redirect, cancel. |

### Customer dashboard

| Client page | Endpoint(s) | Notes |
| --- | --- | --- |
| `dashboard/customer/rentals` | `GET /api/bookings`, `POST /api/bookings/:id/cancel`, `POST /api/payments/create-checkout-session` | Status + payment badges; cancel returns `{refunded,message}` (refund UI). |
| `dashboard/customer/favorites` | `GET /api/favorites`, `DELETE /api/favorites/:equipmentId` | Joined equipment documents in `data[].equipment`. |
| `dashboard/profile` | `GET/PATCH /api/users/me` | Only `name,image,phone,address` accepted. |
| `dashboard` overview | `GET /api/dashboard/customer` | `stats.totalBookings` etc. |

### Owner dashboard

| Client page | Endpoint(s) | Notes |
| --- | --- | --- |
| `dashboard/owner/add-equipment` | `POST /api/owner/equipment` | Creates `status:"pending"` listing. |
| `dashboard/owner/equipment` | `GET /api/owner/equipment`, `DELETE /api/owner/equipment/:id` | Own listings incl. pending/rejected (not just approved). |
| `dashboard/owner/rentals` | `GET /api/bookings/owner/requests`, `POST /api/bookings/:id/decline`, `POST /api/bookings/:id/complete` | Decline/complete actions with refund-aware responses. |
| `dashboard/owner` overview | `GET /api/dashboard/owner` | Earnings, requests by status. |

### Admin dashboard

| Client page | Endpoint(s) | Notes |
| --- | --- | --- |
| `dashboard/admin/equipment` | `GET /api/admin/approvals/equipment?status`, `PATCH /api/admin/approvals/equipment/:id` | Reject **requires** `reason` (≤500 chars). |
| `dashboard/admin/users` | `GET /api/admin/role-management/users`, `PATCH /api/admin/role-management/users/:id/role` | Customer↔Owner only; Admin accounts and self are `403`. |
| `dashboard/admin/rentals` | `GET /api/admin/bookings?status&search&limit` | Platform-wide booking list. |
| `dashboard/admin` overview | `GET /api/dashboard/admin` | User/equipment/booking aggregates. |

### Payments & refunds

| Client feature | Endpoint(s) | Notes |
| --- | --- | --- |
| Checkout redirect | `POST /api/payments/create-checkout-session` | `{bookingId}` → `{url}`; `409` when the stored session already completed. |
| Success page (`payment/success`) | `GET /api/payments/session/:sessionId` | Polls until `paid`/`expired`; never trusts the redirect. |
| Cancel page (`payment/cancel`) | – (link only) | Booking stays `pending_payment`; retry available from rentals/booking form. |
| Payment history | `GET /api/payments/history` | `status`: `pending\|processing\|paid\|expired\|refunded`. |
| Auto-refund on cancel/decline | `POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/decline` | Response `{refunded:true\|false,message}` — the client renders this as the refund confirmation. |
| Refunded state display | booking `paymentStatus` / `status` | `refunded` badge from `paymentStatus` or booking status. |
