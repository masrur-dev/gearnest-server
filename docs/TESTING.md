# GearNest Test Results

## How to run

```bash
npm run test:unit        # isolated unit tests; no database connection
npm test                 # scripts/smoke-test.js — requires a non-production test database
npm run test:webhook     # signed Stripe fixtures; requires a non-production test database
npm run lint             # ESLint over the whole codebase
npm run build            # syntax-checks every file + imports the app module graph
```

The unit-test command explicitly targets `test/*.test.js`; it does not discover
or execute the database-backed scripts. The smoke and webhook suites create
temporary records, so point `MONGODB_URI` at a dedicated non-production test
database before running them.

Optional full admin coverage (requires a known Admin password):

```bash
ADMIN_EMAIL=... ADMIN_PASSWORD=... npm test
```

## Executed results (2026-11-19, local, MongoDB Atlas `gearnestDB`)

**Smoke: 45 passed, 0 failed, 1 skipped.**
**Webhook: 34 passed, 0 failed.**
**Lint: 0 errors. Build check: OK (29 files + both entry points import).**

| Area | Result |
| --- | --- |
| Health & public API (5 tests) | PASS — health, approved-only listing, detail, invalid id → 400, pagination |
| Search, filter & sort (6 tests) | PASS — `search` list, `category` matches only that category, `rentalType=Daily`, `price_asc` ascending, `minPrice=abc` → 400, malformed JSON body → 400 |
| Authentication & profile (10 tests) | PASS — missing JWT → 401, invalid JWT → 401, sign-up token, unknown sign-in fails, stranger account, `/api/me`, profile GET/PATCH, client cannot set `role` → 400 |
| RBAC (3 tests) | PASS — Customer on Owner route → 403, Customer on Admin route → 403, Customer on owner requests → 403 |
| Booking workflow (12 tests) | PASS — create, server-computed price, reversed dates → 400, list own, **stranger booking IDOR → 403**, checkout session (test mode) + **open-session reuse (same URL)** + payment history, **`paymentStatus` exposed on the detail**, cancel (`refunded:false`), **cancelled payment history → `expired`**, double-cancel → 409. Without Stripe keys the checkout test expects `503` instead. |
| Favorites & reviews (5 tests) | PASS — add/list/remove favorite, early review refused (403/409), public reviews |
| Dashboards (2 tests) | PASS — customer stats numeric, Customer blocked from Owner dashboard → 403 |
| Stripe webhook hardening (2 tests) | PASS — configured: unsigned → 400, forged signature → 400. Without keys: → 503. |
| Status filter (manual, this session) | PASS — `?status=active` → 200, `?status=bogus` → 400, no filter → 200 |
| Admin flow (13 tests) | **SKIP** — `ADMIN_EMAIL`/`ADMIN_PASSWORD` not available in this environment |
| Concurrency (in admin flow) | **not executed** — needs Admin credentials |

### Webhook suite (`npm run test:webhook`, 34 tests)

Spawns the server on port 5010 with a throwaway secret and locally HMAC-signs
Stripe-shaped events (no Stripe account/network needed):

| Check | Result |
| --- | --- |
| Invalid signature → 400, booking untouched | PASS |
| Signed `checkout.session.completed` → `pending_payment` → `confirmed`, `paymentStatus: paid` | PASS |
| DB: `payment` record written with amount + owner, event marker `processed` | PASS |
| Redelivered event → `{duplicate:true}`, no state change, no duplicate payment doc | PASS |
| Customer dashboard reports the confirmed booking + upcoming list | PASS |
| `checkout.session.expired` on a second booking → `expired` | PASS |
| `charge.refunded` → booking `refunded` + `paymentStatus: refunded`, payment `refunded` | PASS |
| Booking detail exposes `paymentStatus` | PASS |
| Mismatched booking reference → 400, marker released (retry processes again, no stuck duplicate) | PASS |
| **Stale session** (booking points at A, B paid with matching reference/amount) → booking confirmed, `stripeSessionId` moved to B, A's payment doc `expired`, B `paid` | PASS |
| **Same session, new event id** → `outcome: already_settled`, payment untouched (not refunded) | PASS |
| **Duplicate paid session** → `outcome: duplicate_refund_failed`, extra payment doc `paid` + `refundStatus: failed` for reconciliation, original booking/payment untouched | PASS |
| **Late payment after cancel** → booking stays `cancelled`, `outcome: late_refund_failed`, charge kept `paid` + `refundStatus: failed`, `paymentStatus` not marked refunded | PASS |
| Cleanup: fixtures deleted in `finally` | PASS |

## Covered by code but not by automated tests

- Live Stripe end-to-end (real card → dashboard event → DB confirmation) — needs
  `stripe listen` or a dashboard webhook endpoint; the signed-fixture suite covers
  the same server-side logic without Stripe.
- **Successful** auto-refunds through Stripe (cancel/decline of a paid booking, duplicate/late
  settlement): the code path is exercised but always takes the `refundStatus: "failed"`
  branch in tests, because fixture payment intents (`pi_local_*`) do not exist at Stripe.
  The `charge.refunded` webhook path (marking docs refunded) *is* tested.
- Owner dashboard and Admin dashboard numbers (endpoints exist; the Customer dashboard is
  asserted in both suites).
- Review creation happy path (eligibility and one-per-booking rules are enforced by unique index; only the refusal paths are tested).
- Password recovery (`scripts/recover-admin.js`) — manual, destructive-by-design, requires explicit confirmation env vars.
- Rate limiting, CORS preflight, helmet headers — configured but not asserted.
- JWT expiry (15 min), issuer/audience mismatch — enforced by `jose` config; not simulated in tests.

## Known skips

- **Admin flow:** sign-in, user list, self-role-change refusal, promote/demote, equipment create/approve/reject/duplicate-refusal, owner CRUD, rejection reason, booking concurrency (5 parallel bookings never oversell). Runs fully when `ADMIN_EMAIL` + `ADMIN_PASSWORD` are provided.
