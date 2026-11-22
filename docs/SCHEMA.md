# GearNest Database Schema

Database: `gearnestDB` (MongoDB Atlas). Collections are created implicitly on first write. Indexes: `npm run setup` (`scripts/create-indexes.js`, safe to re-run).

## `user` (Better Auth)

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `id` | string | Better Auth public id (mirrors `_id`) |
| `name`, `email`, `image` | string | |
| `emailVerified` | boolean | |
| `role` | string | `Customer` (default) / `Owner` / `Admin`. **Authoritative source for authorization.** Never settable by clients (`input:false` in Better Auth). |
| `phone`, `address` | string | Editable via `PATCH /api/users/me` |
| `password` | – | stored only in `account`, never returned |
| `createdAt`, `updatedAt` | Date | |

## `account`, `session`, `verification` (Better Auth)

Standard Better Auth collections (credential password hash in `account.password`, sessions in `session`). Not exposed by any API.

## `equipment`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `name`, `description`, `brand`, `model`, `rentalTerms`, `location` | string | validated ≤2000 chars |
| `category` | enum | Construction, Photography, Transportation, Agriculture, Electronics, Events |
| `condition` | enum | New, Excellent, Good, Fair |
| `rentalType` | enum | Daily, Weekly, Monthly |
| `rentalPrice` | number | > 0, price of one unit for one rental-type period |
| `availableQuantity` | int ≥ 1 | stock capacity |
| `image` | string | validated `http(s)` URL |
| `ownerId`, `ownerName`, `ownerEmail` | string | from verified JWT; never from client |
| `status` | enum | `pending` → `approved`/`rejected`; `removed` (soft delete) |
| `rejectionReason` | string | set on rejection (required, ≤500) |
| `reviewedBy`, `reviewedAt` | id/Date | last Admin review |
| `reviewHistory[]` | array | `{status, reviewedBy, reviewedAt, reason}` audit trail |
| `reapprovalRequestedAt`, `deletedAt`, `lastBookedAt` | Date | set by owner edit / soft delete / booking touch |
| `createdAt`, `updatedAt` | Date | |

Indexes: `(status, createdAt)`, `category`, `rentalPrice`, `(ownerId, createdAt)`, `location`.

## `booking`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `equipmentId` | ObjectId | |
| `equipmentName`, `equipmentImage` | string | denormalized snapshot |
| `ownerId`, `ownerName`, `ownerEmail` | string | equipment owner |
| `customerId`, `customerName`, `customerEmail` | string | from verified JWT |
| `quantity` | int ≥ 1 | |
| `rentalType` | enum | snapshot from equipment |
| `startDate`, `endDate` | `YYYY-MM-DD` | inclusive, server-validated |
| `days`, `units`, `unitPrice`, `totalAmount`, `currency` | number | **server-computed**; client cannot influence |
| `status` | enum | `pending_payment`, `confirmed`, `active`, `completed`, `cancelled`, `expired`, `refunded` |
| `paymentStatus` | enum\|null | `pending` → `paid` → `refunded`, plus `failed`; `null` until checkout starts. Cancel/decline refunds set `refunded`; `charge.refunded` sets it too. |
| `paidAt` | Date | set by the settlement (webhook or success page) |
| `stripeSessionId` | string\|null | current Checkout Session (a verified stale session may supersede it) |
| `stripePaymentIntentId` | string\|null | set on settlement; used to match `charge.refunded` |
| `createdAt`, `updatedAt` | Date | |

Indexes: `(customerId, createdAt)`, `(ownerId, createdAt)`, `(equipmentId, status, startDate, endDate)` (availability), `(status, createdAt)`, `stripeSessionId` (sparse).

**Concurrency:** creation runs in a MongoDB transaction that first touches the equipment document (write-write conflict) then re-checks overlapping quantities, so parallel requests cannot oversell.

**Lifecycle:** `pending_payment` older than 30 min → `expired` (lazy, on read). `confirmed` with `startDate ≤ today` → `active`; `active` with `endDate < today` → `completed` (lazy, on read). Shared by booking routes **and all dashboards** (`config/booking-lifecycle.js`). No Stripe calls happen on this hot path: money arriving after expiry/cancellation is refunded by the webhook settlement instead.

## `payment`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `bookingId`, `userId` | id | empty on webhook idempotency markers |
| `amount`, `currency` | number/string | in major currency units; empty on markers |
| `status` | enum | `pending`, `processing`, `paid`, `failed`, `expired`, `refunded` |
| `refundStatus` | `failed` | set when an auto-refund fails; the doc stays `paid` and the log carries a `RECONCILIATION` line |
| `refundError` | string | truncated Stripe error (cleared when a later refund succeeds) |
| `refundedAt` | Date | |
| `stripeSessionId` | string | unique (sparse) |
| `stripeEventId` | string | unique (sparse) → webhook idempotency (`processing` → `processed`; deleted again on 500 so Stripe can retry) |
| `stripePaymentIntentId` | string\|null | |
| `createdAt`, `updatedAt` | Date | |

## `favorite`

`{ _id, userId, equipmentId (ObjectId), createdAt }` — unique `(userId, equipmentId)`.

## `review`

`{ _id, equipmentId, bookingId, userId, userName, rating (1–5), comment, createdAt }` — unique `(bookingId, userId)` (one review per rental).

## `jwks`

Better Auth JWT plugin key set (published at `GET /api/auth/jwks`).

## Legacy / seeded data

Seed equipment (`scripts/seedEquipment.js`) uses `ownerId:"demo-owner"` and may have empty `image`; public queries handle this safely (approved status + fields read with fallbacks). No schema migration is required or performed.
