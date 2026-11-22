# GearNest Server

Backend for the GearNest equipment rental platform (Programming Hero Assignment 9, Category 003).

**Stack:** Node.js · Express 5 · MongoDB Atlas · Better Auth · jose (JWT) · Stripe

## Quick start

```bash
npm install
cp .env.example .env      # then fill in real values
npm run setup             # creates indexes (safe to re-run)
npm run dev               # http://localhost:5000
```

Health check: `GET /api/health`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with nodemon |
| `npm start` | Start with node |
| `npm run setup` | Create MongoDB indexes (`scripts/create-indexes.js`) |
| `npm test` | Run smoke tests (`scripts/smoke-test.js`) |
| `npm run test:webhook` | Signed Stripe webhook suite (`scripts/webhook-test.js`, no Stripe account needed) |
| `npm run lint` | ESLint (flat config, `eslint.config.js`) |
| `npm run build` | Build check: `node --check` every file + import `app.js`/`api/index.js` |
| `node scripts/seedEquipment.js` | Seed demo equipment (only when collection is empty) |
| `node scripts/bootstrap-admin.js` | Promote the FIRST admin (disabled once one exists) |
| `node scripts/recover-admin.js` | Local-only lost-admin password recovery |

## Admin access

- **First admin:** register through the app, then
  `CONFIRM_ADMIN_BOOTSTRAP=YES ADMIN_EMAIL=you@example.com node scripts/bootstrap-admin.js`
- **Lost password:** `CONFIRM_ADMIN_RECOVERY=YES RECOVER_ADMIN_EMAIL=you@example.com node scripts/recover-admin.js`
  (prompts for a new password, verifies the database and account, requires typing the email, revokes sessions, logs an audit line).

## Documentation

- [API reference](docs/API.md) — endpoints, request/response formats, auth rules, Stripe flow
- [Database schema](docs/SCHEMA.md) — collections, fields, indexes
- [Testing](docs/TESTING.md) — what was executed and what was not
- [Deployment](docs/DEPLOYMENT.md) — environment variables, Vercel, Stripe webhook

## Security summary

- JWTs are verified with Better Auth's published JWKS: signature, issuer, audience and expiry are checked, and the **role is always read from MongoDB, never from the token**.
- 401 = missing/invalid/expired token, 403 = insufficient role.
- Clients cannot set `role`, `email`, `password` or `ownerId` through any endpoint.
- The last Admin cannot be demoted; admins cannot change their own role.
- Equipment/booking/favorite/review ownership is enforced on the server (no IDOR).
- Prices and rental periods are calculated on the server from stored equipment data.
- Booking availability uses a MongoDB transaction, so concurrent requests cannot oversell stock.
- Stripe webhooks are signature-verified against the raw body and are idempotent.
- Money that arrives is settled through one decision point: confirm the booking, ignore repeats, and **auto-refund** duplicate sessions or payments landing on cancelled/expired bookings; a refund that fails is logged loudly (`RECONCILIATION`) and recorded as `refundStatus: failed`.
- Cancelling or declining a paid booking refunds it automatically; unpaid bookings have their open Checkout Session retired so payment history never stays pending.
- `helmet`, CORS allow-list, and rate limits on `/api/auth` and `/api` are enabled. `.env` is gitignored; no secrets are logged.

## Known limitations

- **Email delivery is not configured**, so Better Auth's built-in "forgot password" email flow is unavailable. Local recovery (`scripts/recover-admin.js`) covers lost admin access; other users must be reset the same way or re-registered.
- **Google login** was not enabled (no OAuth credentials provided).
- **Stripe runs in test mode.** Without `STRIPE_SECRET_KEY` the checkout endpoint and webhook answer 503; with keys set they work against Stripe test mode, and `npm run test:webhook` verifies the whole webhook contract locally with signed fixtures.
- **Image upload** stores an image URL (validated `http(s)`) — no file upload/hosting integration, since no image-host credentials were provided.
- Automated coverage is a smoke-test suite (see [docs/TESTING.md](docs/TESTING.md)); it is not a full unit-test suite.
- No email notifications (booking confirmations, approvals) are sent.

## Suggested commits

1. `fix: repair middleware ordering and remove duplicate approval route`
2. `feat: add app factory, security headers and auth rate limiting`
3. `feat: complete owner equipment CRUD with re-approval policy`
4. `feat: extend admin approval with reasons and review history`
5. `feat: add pagination and indexes to public equipment API`
6. `feat: implement booking system with transactional availability`
7. `feat: integrate stripe checkout and verified webhooks`
8. `feat: build real customer owner and admin dashboards`
9. `feat: add favorites and review endpoints`
10. `feat: harden admin user management and last-admin guard`
11. `feat: add local admin recovery and index scripts`
12. `chore: vercel deployment config, env example and docs`
