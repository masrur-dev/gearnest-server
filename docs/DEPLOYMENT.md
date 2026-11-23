# GearNest Deployment

## Environment variables (names only — never commit values)

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | integer from 1–65535 (default 5000) |
| `CLIENT_URL` | yes | absolute HTTP(S) frontend origin — CORS allow-list + Better Auth `trustedOrigins` |
| `MONGODB_URI` | yes | valid `mongodb://` or `mongodb+srv://` connection string |
| `DB_NAME` | yes | `gearnestDB` |
| `BETTER_AUTH_URL` | yes | absolute HTTP(S) Better Auth public base URL (local `http://localhost:5000`; prod frontend origin) — also the JWT issuer/audience |
| `BETTER_AUTH_SECRET` | yes | random secret of at least 32 bytes (Better Auth signing secret) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google OAuth | Configure both or neither |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for GitHub OAuth | Configure both or neither |
| `STRIPE_SECRET_KEY` | for payments | Stripe **test-mode** secret; endpoints answer 503 without it |
| `STRIPE_WEBHOOK_SECRET` | for payments | `whsec_...` from `stripe listen` / dashboard endpoint |
| `PAYMENT_SUCCESS_PATH` / `PAYMENT_CANCEL_PATH` | no | frontend redirect paths (defaults `/payment/success`, `/payment/cancel`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | test-only | optional admin smoke-test coverage |
| `CONFIRM_ADMIN_BOOTSTRAP`, `CONFIRM_ADMIN_RECOVERY`, `RECOVER_ADMIN_EMAIL` | scripts only | explicit confirmation for local admin scripts; **never set in the running app** |

`.env` is gitignored (`.env.*` too, except `.env.example`).

At startup the server validates the MongoDB URI, Better Auth secret, optional
HTTP(S) URLs, OAuth credential pairs, and `PORT`. Errors identify variable
names only; secret values are never included in validation messages.

## Local

```bash
npm install
cp .env.example .env    # fill in values
npm run setup           # indexes (idempotent)
npm run dev             # nodemon on :5000
npm run lint            # ESLint
npm run build           # syntax + module-graph check
npm test                # smoke tests
npm run test:webhook    # signed webhook suite
```

## Vercel (serverless)

- `api/index.js` mounts the shared Express app; `vercel.json` rewrites all paths to it.
- Set every required variable above in the Vercel project (production scope).
- Set `CLIENT_URL` and `BETTER_AUTH_URL` to `https://gearnest-client-rouge.vercel.app`.
- On the frontend Vercel project, set `NEXT_PUBLIC_API_URL=https://gearnest-server-seven.vercel.app` and `NEXT_PUBLIC_AUTH_URL=https://gearnest-client-rouge.vercel.app`.
- Next.js proxies `/api/auth/*` to `NEXT_PUBLIC_API_URL`. Browser booking and payment API calls continue to use the backend URL.
- Set the GitHub OAuth application's callback URL to `https://gearnest-client-rouge.vercel.app/api/auth/callback/github`.
- Auth cookies are `Secure`, `HttpOnly`, and `SameSite=Lax` in production. Do not configure cross-site cookies or disable state/CSRF validation.
- `BETTER_AUTH_URL` is also the JWT issuer and audience. JWT verification and the JWKS endpoint remain enabled; users may need to sign in again after changing the issuer.
- The app builds once per cold start and reuses the Mongo client across warm invocations.

## Stripe webhook

1. Create a Checkout webhook for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
2. Local: `stripe listen --forward-to localhost:5000/api/payments/webhook` (test mode).
3. Production URL: `https://<api-domain>/api/payments/webhook`.
4. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
5. Use test-mode keys only in development; the webhook route is registered **before** `express.json` and verifies signatures against the raw body.
6. The handler only trusts sessions created by this server: `metadata.bookingId` + `client_reference_id` must identify the booking and `mode` must be `payment`; Stripe must deliver the session **paid** (`payment_status: paid`) for confirmation; redeliveries of an event id are acknowledged without side effects, while a `400`/`500` answer releases the marker so Stripe's retry can be processed.
7. **Settlement rules for paid sessions** (`outcome` in the response and in the logs):
   - `confirmed` — session id, amount and currency all match a `pending_payment` booking.
   - `confirmed_stale_session` — everything matches but the booking's stored session id moved on (the verified session supersedes it; the old payment doc becomes `expired`).
   - `already_settled` — the booking is already paid for this session (idempotent no-op).
   - `duplicate_refunded` / `duplicate_refund_failed` — a *different* session paid an already-paid booking → refunded; on refund failure the extra payment doc stays `paid` with `refundStatus: failed` for reconciliation.
   - `late_refunded` / `late_refund_failed` — the booking was cancelled/expired when the money arrived → refunded; the booking never leaves its non-payable status.
   - `reconciliation` — a paid session that cannot be verified (logged with `RECONCILIATION`, needs a human).
   Failed/expired events keep the strict `session.id`/`amount_total`/`currency` check and never touch a paid booking.

## Production checklist

- [ ] Atlas IP allow-list / network access for the host
- [ ] `BETTER_AUTH_URL` + `CLIENT_URL` set to the frontend origin and frontend `NEXT_PUBLIC_AUTH_URL` / `NEXT_PUBLIC_API_URL` configured
- [ ] CORS and Better Auth `trustedOrigins` cover exactly the frontend domain
- [ ] Stripe test keys + webhook secret set; webhook endpoint registered
- [ ] `npm run setup` run once against the production database
- [ ] `npm run lint` and `npm run build` pass
- [ ] `GET /api/health` returns 200 after deploy
- [ ] Admin account exists (register, then run `scripts/bootstrap-admin.js` **once** locally, or use `scripts/recover-admin.js` for a lost password)
- [ ] No secrets in logs or responses (`helmet`, no `x-powered-by`, generic 500s)

Do not run admin scripts against production without explicit operator confirmation — both require `CONFIRM_*=YES` and verify the target database/account first.
