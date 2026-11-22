
// GearNest backend smoke tests.
//
//   npm test              (starts the server if it is not running)
//
// Optional admin coverage (full approval + RBAC flow):
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm test
//
// Without ADMIN_EMAIL/ADMIN_PASSWORD the suite self-provisions a
// throwaway Admin account directly in the test database, runs the
// full admin flow with it, then demotes it back to Customer and
// revokes its sessions. No real credentials are needed or printed.
//
// Exit code 0 = every executed test passed.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";

import "dotenv/config";

import { connectDB, getDB } from "../config/db.js";

const BASE = process.env.BASE_URL || "http://localhost:5000";
const ORIGIN =
  process.env.CLIENT_URL || "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the local server when it is not already up.
async function ensureServer() {
  try {
    const probe = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });

    if (probe.ok) return null;
  } catch {
    // not running - start it below
  }

  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("../index.js", import.meta.url))],
    { stdio: "ignore" }
  );

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);

    try {
      const probe = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });

      if (probe.ok) return server;
    } catch {
      // keep waiting
    }
  }

  server.kill();
  throw new Error(`Server did not start at ${BASE}`);
}

let passed = 0;
let failed = 0;
const skipped = [];

function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name, reason) {
  skipped.push(`${name} (${reason})`);
  console.log(`  SKIP  ${name} — ${reason}`);
}

async function call(method, path, { token, body, headers: extra } = {}) {
  const headers = { origin: ORIGIN, ...(extra ?? {}) };

  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json;

  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return {
    status: response.status,
    json,
    setCookie: response.headers.get("set-cookie"),
  };
}

// Better Auth returns a session token from sign-up/sign-in;
// the JWT used by the API comes from GET /api/auth/token,
// which needs the full signed session cookie.
async function toJwt(setCookie) {
  if (!setCookie) return null;

  const cookie = setCookie.split(";")[0];

  const response = await fetch(`${BASE}/api/auth/token`, {
    headers: { origin: ORIGIN, cookie },
  });

  if (!response.ok) return null;

  const json = await response.json().catch(() => null);
  return json?.token ?? null;
}

async function signUp(email, password, name) {
  const { status, json, setCookie } = await call(
    "POST",
    "/api/auth/sign-up/email",
    { body: { email, password, name } }
  );

  return {
    status,
    json,
    token: await toJwt(setCookie),
  };
}

async function signIn(email, password) {
  const { status, json, setCookie } = await call(
    "POST",
    "/api/auth/sign-in/email",
    { body: { email, password } }
  );

  return {
    status,
    json,
    token: await toJwt(setCookie),
  };
}

async function main() {
  await ensureServer();

  const stamp = Date.now();
  const customerEmail = `smoke.customer.${stamp}@example.com`;
  const strangerEmail = `smoke.stranger.${stamp}@example.com`;
  const password = "SmokeTest!123";

  console.log(`\nGearNest smoke tests → ${BASE}\n`);

  // ---------- Health ----------
  console.log("Health & public API");
  const health = await call("GET", "/api/health");
  ok("GET /api/health returns 200", health.status === 200);

  const list = await call("GET", "/api/equipment");
  ok(
    "GET /api/equipment returns approved items",
    list.status === 200 &&
      Array.isArray(list.json?.data) &&
      list.json.data.every((e) => e.status === "approved")
  );

  const approved = (list.json?.data ?? []).find(
    (e) => e.availableQuantity >= 2
  );

  const detail = approved
    ? await call("GET", `/api/equipment/${approved._id}`)
    : null;

  ok(
    "GET /api/equipment/:id returns the listing",
    detail !== null && detail.status === 200
  );

  const badId = await call("GET", "/api/equipment/not-an-id");
  ok(
    "Invalid equipment id returns 400",
    badId.status === 400
  );

  const page = await call("GET", "/api/equipment?page=1&limit=2");
  ok(
    "GET /api/equipment paginates",
    page.status === 200 &&
      typeof page.json?.total === "number" &&
      page.json.data.length <= 2
  );

  // ---------- Search, filter, sort ----------
  console.log("\nSearch, filter & sort");

  const search = await call(
    "GET",
    "/api/equipment?search=drill"
  );
  ok(
    "Search query returns a list",
    search.status === 200 &&
      Array.isArray(search.json?.data),
    `status ${search.status}`
  );

  if (approved) {
    const byCategory = await call(
      "GET",
      `/api/equipment?category=${encodeURIComponent(
        approved.category
      )}`
    );
    ok(
      "Category filter matches only that category",
      byCategory.status === 200 &&
        (byCategory.json?.data ?? []).length >= 1 &&
        byCategory.json.data.every(
          (e) => e.category === approved.category
        ),
      `status ${byCategory.status}`
    );
  } else {
    skip("Category filter", "no approved equipment");
  }

  const byRentalType = await call(
    "GET",
    "/api/equipment?rentalType=Daily"
  );
  ok(
    "rentalType filter keeps only Daily items",
    byRentalType.status === 200 &&
      (byRentalType.json?.data ?? []).every(
        (e) => e.rentalType === "Daily"
      ),
    `status ${byRentalType.status}`
  );

  const sorted = await call(
    "GET",
    "/api/equipment?sort=price_asc"
  );
  const prices = (sorted.json?.data ?? []).map(
    (e) => e.rentalPrice
  );
  ok(
    "price_asc sorts ascending",
    sorted.status === 200 &&
      prices.every(
        (price, i) => i === 0 || prices[i - 1] <= price
      ),
    `status ${sorted.status}`
  );

  const badPrice = await call(
    "GET",
    "/api/equipment?minPrice=abc"
  );
  ok(
    "Invalid price filter returns 400",
    badPrice.status === 400,
    `status ${badPrice.status}`
  );

  // ---------- Malformed payload ----------
  const rawBadJson = await fetch(
    `${BASE}/api/bookings`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: "{not json",
    }
  );
  ok(
    "Malformed JSON body returns 400",
    rawBadJson.status === 400,
    `status ${rawBadJson.status}`
  );

  // ---------- Auth ----------
  console.log("\nAuthentication & profile");

  const noAuth = await call("GET", "/api/dashboard/me");
  ok("Missing JWT returns 401", noAuth.status === 401);

  const badAuth = await call("GET", "/api/dashboard/me", {
    token: "garbage.token.here",
  });
  ok("Invalid JWT returns 401", badAuth.status === 401);

  const signup = await signUp(customerEmail, password, "Smoke Customer");
  ok(
    "Registration returns a token",
    signup.status === 200 || signup.status === 201,
    `status ${signup.status}`
  );

  const customerToken = signup.token;
  ok("Customer token received", Boolean(customerToken));

  const signin = await signIn(strangerEmail, password);
  ok(
    "Signing in with unknown account fails",
    signin.status >= 400
  );

  const stranger = await signUp(
    strangerEmail,
    password,
    "Smoke Stranger"
  );
  ok(
    "Stranger account registered",
    Boolean(stranger.token),
    `status ${stranger.status}`
  );

  const me = await call("GET", "/api/me", { token: customerToken });
  ok(
    "GET /api/me returns the session user",
    me.status === 200 && me.json?.user?.email === customerEmail
  );

  const profile = await call("GET", "/api/users/me", {
    token: customerToken,
  });
  ok(
    "GET /api/users/me returns the profile",
    profile.status === 200 &&
      profile.json?.user?.role === "Customer"
  );

  const patchOk = await call("PATCH", "/api/users/me", {
    token: customerToken,
    body: { phone: "+1 555 0100", address: "Test Street 1" },
  });
  ok(
    "PATCH /api/users/me updates phone and address",
    patchOk.status === 200
  );

  const patchRole = await call("PATCH", "/api/users/me", {
    token: customerToken,
    body: { role: "Admin" },
  });
  ok(
    "Clients cannot set their own role",
    patchRole.status === 400
  );

  // ---------- RBAC ----------
  console.log("\nRole based access");

  const ownerRoute = await call("POST", "/api/owner/equipment", {
    token: customerToken,
    body: {},
  });
  ok(
    "Customer cannot use Owner endpoints (403)",
    ownerRoute.status === 403
  );

  const adminRoute = await call("GET", "/api/admin/users", {
    token: customerToken,
  });
  ok(
    "Customer cannot use Admin endpoints (403)",
    adminRoute.status === 403
  );

  const adminBookings = await call(
    "GET",
    "/api/admin/bookings",
    { token: customerToken }
  );
  ok(
    "Customer cannot read the platform booking list (403)",
    adminBookings.status === 403,
    `status ${adminBookings.status}`
  );

  const ownerRequests = await call(
    "GET",
    "/api/bookings/owner/requests",
    { token: customerToken }
  );
  ok(
    "Customer cannot read owner requests (403)",
    ownerRequests.status === 403,
    `status ${ownerRequests.status}`
  );

  // ---------- Bookings ----------
  console.log("\nBooking workflow");

  let bookingId = null;

  if (approved) {
    const future = new Date(Date.now() + 14 * 86400000);
    const startDate = future.toISOString().slice(0, 10);
    const endDate = new Date(
      future.getTime() + 2 * 86400000
    )
      .toISOString()
      .slice(0, 10);

    const created = await call("POST", "/api/bookings", {
      token: customerToken,
      body: {
        equipmentId: approved._id,
        quantity: 1,
        startDate,
        endDate,
      },
    });

    ok(
      "Customer can create a booking",
      created.status === 201,
      `status ${created.status} ${JSON.stringify(created.json)}`
    );

    bookingId = created.json?.data?.id ?? null;

    ok(
      "Server computed the price",
      typeof created.json?.data?.totalAmount === "number" &&
        created.json.data.totalAmount > 0
    );

    const reversed = await call("POST", "/api/bookings", {
      token: customerToken,
      body: {
        equipmentId: approved._id,
        quantity: 1,
        startDate: endDate,
        endDate: startDate,
      },
    });
    ok(
      "Reversed dates are rejected",
      reversed.status === 400
    );

    const mine = await call("GET", "/api/bookings", {
      token: customerToken,
    });
    ok(
      "Customer sees their bookings",
      mine.status === 200 &&
        Array.isArray(mine.json?.data) &&
        mine.json.data.some((b) => b.id === bookingId)
    );

    if (stranger.token) {
      const foreign = await call(
        "GET",
        `/api/bookings/${bookingId}`,
        { token: stranger.token }
      );
      ok(
        "Stranger cannot read another customer's booking (403)",
        foreign.status === 403,
        `status ${foreign.status}`
      );
    }

    const stripeCheckoutReady = Boolean(
      process.env.STRIPE_SECRET_KEY
    );

    const checkout = await call(
      "POST",
      "/api/payments/create-checkout-session",
      { token: customerToken, body: { bookingId } }
    );

    if (stripeCheckoutReady) {
      ok(
        "Checkout session is created (Stripe test mode)",
        checkout.status === 200 &&
          typeof checkout.json?.url === "string" &&
          checkout.json.url.includes("stripe.com"),
        `status ${checkout.status} ${JSON.stringify(checkout.json)}`
      );

      const checkoutAgain = await call(
        "POST",
        "/api/payments/create-checkout-session",
        { token: customerToken, body: { bookingId } }
      );
      ok(
        "Second checkout reuses the open session",
        checkoutAgain.status === 200 &&
          checkoutAgain.json?.url === checkout.json?.url,
        `status ${checkoutAgain.status} same=${
          checkoutAgain.json?.url === checkout.json?.url
        }`
      );

      const history = await call("GET", "/api/payments/history", {
        token: customerToken,
      });
      ok(
        "Pending payment is tracked in payment history",
        history.status === 200 &&
          (history.json?.data ?? []).some(
            (p) => p.bookingId === bookingId
          ),
        `status ${history.status}`
      );
    } else {
      ok(
        "Checkout answers 503 without Stripe keys",
        checkout.status === 503,
        `status ${checkout.status}`
      );
    }

    const bookingView = await call(
      "GET",
      `/api/bookings/${bookingId}`,
      { token: customerToken }
    );
    ok(
      "Booking detail exposes paymentStatus",
      bookingView.status === 200 &&
        bookingView.json?.data?.paymentStatus ===
          (stripeCheckoutReady ? "pending" : null),
      `paymentStatus ${
        bookingView.json?.data?.paymentStatus
      }`
    );

    if (stripeCheckoutReady) {
      // ----- Payment session status (server-side truth) -----
      const sessionId =
        bookingView.json?.data?.stripeSessionId ?? null;

      ok(
        "Booking detail exposes stripeSessionId",
        typeof sessionId === "string" &&
          sessionId.startsWith("cs_"),
        `sessionId ${sessionId}`
      );

      if (sessionId) {
        const sessionStatus = await call(
          "GET",
          `/api/payments/session/${sessionId}`,
          { token: customerToken }
        );
        ok(
          "Session status reports pending for an unpaid session",
          sessionStatus.status === 200 &&
            sessionStatus.json?.paymentStatus === "pending" &&
            sessionStatus.json?.bookingStatus ===
              "pending_payment",
          `status ${sessionStatus.status} ${JSON.stringify(
            sessionStatus.json
          )}`
        );

        const badSession = await call(
          "GET",
          "/api/payments/session/not-a-session",
          { token: customerToken }
        );
        ok(
          "Malformed session id returns 400",
          badSession.status === 400,
          `status ${badSession.status}`
        );

        if (stranger.token) {
          const foreignSession = await call(
            "GET",
            `/api/payments/session/${sessionId}`,
            { token: stranger.token }
          );
          ok(
            "Stranger cannot read another user's session (404)",
            foreignSession.status === 404,
            `status ${foreignSession.status}`
          );
        }
      }
    }

    const cancelled = await call(
      "POST",
      `/api/bookings/${bookingId}/cancel`,
      { token: customerToken }
    );
    ok(
      "Customer can cancel a pending booking",
      cancelled.status === 200 &&
        cancelled.json?.refunded === false,
      `status ${cancelled.status} ${JSON.stringify(
        cancelled.json
      )}`
    );

    if (stripeCheckoutReady) {
      const historyAfter = await call(
        "GET",
        "/api/payments/history",
        { token: customerToken }
      );
      ok(
        "Cancelled booking payment shows expired",
        historyAfter.status === 200 &&
          (historyAfter.json?.data ?? []).some(
            (p) =>
              p.bookingId === bookingId &&
              p.status === "expired"
          ),
        JSON.stringify(historyAfter.json?.data ?? [])
      );

      const sessionIdAfter =
        bookingView.json?.data?.stripeSessionId;

      if (typeof sessionIdAfter === "string") {
        const sessionAfter = await call(
          "GET",
          `/api/payments/session/${sessionIdAfter}`,
          { token: customerToken }
        );
        ok(
          "Cancel retires the open Checkout Session",
          sessionAfter.status === 200 &&
            sessionAfter.json?.paymentStatus === "expired" &&
            sessionAfter.json?.bookingStatus === "cancelled",
          `status ${sessionAfter.status} ${JSON.stringify(
            sessionAfter.json
          )}`
        );
      }
    }

    const cancelAgain = await call(
      "POST",
      `/api/bookings/${bookingId}/cancel`,
      { token: customerToken }
    );
    ok(
      "Cancelling twice is refused",
      cancelAgain.status === 409
    );
  } else {
    skip("Booking workflow", "no approved equipment with stock");
  }

  // ---------- Favorites ----------
  console.log("\nFavorites & reviews");

  if (approved) {
    const add = await call(
      "POST",
      `/api/favorites/${approved._id}`,
      { token: customerToken }
    );
    ok("Add favorite", add.status === 201);

    const favs = await call("GET", "/api/favorites", {
      token: customerToken,
    });
    ok(
      "List favorites",
      favs.status === 200 &&
        favs.json.data.some(
          (f) => f.equipmentId === String(approved._id)
        )
    );

    const del = await call(
      "DELETE",
      `/api/favorites/${approved._id}`,
      { token: customerToken }
    );
    ok("Remove favorite", del.status === 200);
  } else {
    skip("Favorites", "no approved equipment");
  }

  const reviewTooEarly = await call("POST", "/api/reviews", {
    token: customerToken,
    body: {
      equipmentId: approved?._id ?? "0".repeat(24),
      bookingId: bookingId ?? "0".repeat(24),
      rating: 5,
      comment: "x",
    },
  });
  ok(
    "Review before completion is refused",
    reviewTooEarly.status === 403 ||
      reviewTooEarly.status === 409
  );

  if (approved) {
    const publicReviews = await call(
      "GET",
      `/api/reviews/equipment/${approved._id}`
    );
    ok(
      "Public reviews endpoint works",
      publicReviews.status === 200 &&
        typeof publicReviews.json?.averageRating === "number"
    );
  }

  // ---------- Dashboards ----------
  console.log("\nDashboards");

  const dashCustomer = await call("GET", "/api/dashboard/customer", {
    token: customerToken,
  });
  ok(
    "Customer dashboard returns real stats",
    dashCustomer.status === 200 &&
      typeof dashCustomer.json?.stats?.totalBookings === "number"
  );

  const dashOwner = await call("GET", "/api/dashboard/owner", {
    token: customerToken,
  });
  ok("Customer cannot open Owner dashboard", dashOwner.status === 403);

  // ---------- Webhook hardening ----------
  console.log("\nStripe webhook");

  const webhookConfigured = Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_WEBHOOK_SECRET
  );

  const webhookUnsigned = await call(
    "POST",
    "/api/payments/webhook",
    { body: { id: "evt_test", type: "checkout.session.completed" } }
  );

  if (webhookConfigured) {
    ok(
      "Webhook without a signature is rejected",
      webhookUnsigned.status === 400,
      `status ${webhookUnsigned.status}`
    );

    const webhookBadSignature = await call(
      "POST",
      "/api/payments/webhook",
      {
        body: { id: "evt_test", type: "checkout.session.completed" },
        headers: {
          "stripe-signature":
            "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      }
    );
    ok(
      "Webhook with a forged signature is rejected",
      webhookBadSignature.status === 400,
      `status ${webhookBadSignature.status}`
    );
  } else {
    ok(
      "Webhook without configuration returns 503",
      webhookUnsigned.status === 503,
      `status ${webhookUnsigned.status}`
    );
  }

  // ---------- Admin flow ----------
  console.log("\nAdmin flow");

  let adminEmail = process.env.ADMIN_EMAIL?.trim() || null;
  let adminPassword = process.env.ADMIN_PASSWORD || null;
  let provisionedAdminEmail = null;

  if (!adminEmail || !adminPassword) {
    // No shared credentials in this environment: promote a
    // throwaway account to Admin directly in the test database,
    // run the full flow, then demote it again in the cleanup.
    const throwawayEmail = `smoke.admin.${stamp}@example.com`;
    const throwawayPassword = "SmokeTest!123";

    try {
      const provision = await signUp(
        throwawayEmail,
        throwawayPassword,
        "Smoke Admin"
      );

      if (provision.token) {
        await connectDB();

        const users = getDB().collection("user");
        const doc = await users.findOne({
          email: throwawayEmail,
        });

        if (doc) {
          const promoted = await users.updateOne(
            { _id: doc._id },
            {
              $set: {
                role: "Admin",
                updatedAt: new Date(),
              },
            }
          );

          if (promoted.modifiedCount === 1) {
            adminEmail = throwawayEmail;
            adminPassword = throwawayPassword;
            provisionedAdminEmail = throwawayEmail;

            console.log(
              "  INFO  ADMIN_EMAIL/ADMIN_PASSWORD not set — " +
                "self-provisioned a throwaway Admin for this run"
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "  WARN  throwaway admin provisioning failed:",
        error?.message
      );
    }

    if (!provisionedAdminEmail) {
      skip(
        "Admin flow",
        "set ADMIN_EMAIL and ADMIN_PASSWORD to run (self-provisioning failed)"
      );
    }
  }

  if (adminEmail && adminPassword) {
    try {
      const adminSignin = await signIn(adminEmail, adminPassword);
      ok(
        "Admin can sign in",
        adminSignin.status === 200 && Boolean(adminSignin.token)
      );

      const adminToken = adminSignin.token;

      if (adminToken) {
        const users = await call("GET", "/api/admin/users", {
          token: adminToken,
        });
        ok(
          "Admin lists users",
          users.status === 200 && Array.isArray(users.json?.data)
        );

        const selfRole = await call(
          "PATCH",
          `/api/admin/users/${
            users.json?.data?.find((u) => u.email === adminEmail)
              ?.id ?? "0".repeat(24)
          }/role`,
          { token: adminToken, body: { role: "Customer" } }
        );
        ok(
          "Admin cannot change their own role",
          selfRole.status === 403
        );

        const lastAdmin = await call(
          "GET",
          "/api/dashboard/admin",
          { token: adminToken }
        );
      ok(
        "Admin dashboard returns real stats",
        lastAdmin.status === 200 &&
          typeof lastAdmin.json?.stats?.totalUsers === "number"
      );

      const allBookings = await call(
        "GET",
        "/api/admin/bookings",
        { token: adminToken }
      );
      ok(
        "Admin lists all platform bookings",
        allBookings.status === 200 &&
          Array.isArray(allBookings.json?.data) &&
          typeof allBookings.json?.total === "number" &&
          allBookings.json.total >= allBookings.json.data.length,
        `status ${allBookings.status} ${JSON.stringify(
          allBookings.json
        )?.slice(0, 200)}`
      );

      const filteredBookings = await call(
        "GET",
        "/api/admin/bookings?status=cancelled",
        { token: adminToken }
      );
      ok(
        "Admin booking list honours the status filter",
        filteredBookings.status === 200 &&
          (filteredBookings.json?.data ?? []).every(
            (b) => b.status === "cancelled"
          ),
        `status ${filteredBookings.status}`
      );

        // Promote the smoke customer to Owner for equipment tests.
        const target = (users.json?.data ?? []).find(
          (u) => u.email === customerEmail
        );

        if (target) {
          const promote = await call(
            "PATCH",
            `/api/admin/users/${target.id}/role`,
            { token: adminToken, body: { role: "Owner" } }
          );
          ok(
            "Admin promotes Customer to Owner",
            promote.status === 200
          );

          const ownerToken = customerToken;

          const addEquipment = await call(
            "POST",
            "/api/owner/equipment",
            {
              token: ownerToken,
              body: {
                name: `Smoke Excavator ${stamp}`,
                description: "Created by smoke tests.",
                category: "Construction",
                location: "Test City",
                rentalPrice: 120,
                rentalType: "Daily",
                availableQuantity: 2,
                condition: "Good",
                brand: "TestBrand",
                model: "T-100",
                image: "https://example.com/excavator.png",
                rentalTerms: "Return clean.",
              },
            }
          );
          ok(
            "Owner creates equipment as pending",
            addEquipment.status === 201 &&
              addEquipment.json?.data?.status === "pending",
            `status ${addEquipment.status}`
          );

          const newId = addEquipment.json?.data?._id;

          const pending = await call(
            "GET",
            "/api/admin/approvals/equipment",
            { token: adminToken }
          );
          ok(
            "Admin sees pending equipment (JSON body works)",
            pending.status === 200 &&
              Array.isArray(pending.json?.data) &&
              pending.json.data.some((e) => e._id === newId)
          );

          const approve = await call(
            "PATCH",
            `/api/admin/approvals/equipment/${newId}`,
            { token: adminToken, body: { status: "approved" } }
          );
          ok(
            "Admin approves equipment",
            approve.status === 200,
            `status ${approve.status} ${JSON.stringify(approve.json)}`
          );

          const approveAgain = await call(
            "PATCH",
            `/api/admin/approvals/equipment/${newId}`,
            { token: adminToken, body: { status: "approved" } }
          );
          ok(
            "Duplicate approval is refused",
            approveAgain.status === 409
          );

          const roleList = await call(
            "GET",
            "/api/admin/role-management/users",
            { token: adminToken }
          );
          ok(
            "Role management lists users (JSON body works)",
            roleList.status === 200 &&
              Array.isArray(roleList.json?.data),
            `status ${roleList.status}`
          );

          // ----- Owner CRUD + rejection reason -----

          const second = await call(
            "POST",
            "/api/owner/equipment",
            {
              token: ownerToken,
              body: {
                name: `Smoke Reject Me ${stamp}`,
                description: "Should be rejected.",
                category: "Events",
                location: "Test City",
                rentalPrice: 40,
                rentalType: "Daily",
                availableQuantity: 1,
                condition: "Fair",
                brand: "TestBrand",
                model: "R-1",
                image: "https://example.com/speaker.png",
                rentalTerms: "Handle with care.",
              },
            }
          );

          const secondId = second.json?.data?._id;

          const reject = await call(
            "PATCH",
            `/api/admin/approvals/equipment/${secondId}`,
            {
              token: adminToken,
              body: {
                status: "rejected",
                reason: "Photos do not match the item",
              },
            }
          );
          ok(
            "Admin rejects with a reason",
            reject.status === 200,
            `status ${reject.status}`
          );

          const rejectAgain = await call(
            "PATCH",
            `/api/admin/approvals/equipment/${secondId}`,
            {
              token: adminToken,
              body: { status: "rejected", reason: "again" },
            }
          );
          ok(
            "Duplicate rejection is refused",
            rejectAgain.status === 409
          );

          const rejectedList = await call(
            "GET",
            "/api/admin/approvals/equipment?status=rejected",
            { token: adminToken }
          );
          const rejectedDoc = (
            rejectedList.json?.data ?? []
          ).find((e) => e._id === secondId);

          ok(
            "Rejected listing stores the reason",
            rejectedList.status === 200 &&
              rejectedDoc?.rejectionReason ===
                "Photos do not match the item"
          );

          const ownDetail = await call(
            "GET",
            `/api/owner/equipment/${newId}`,
            { token: ownerToken }
          );
          ok(
            "Owner reads own equipment by id",
            ownDetail.status === 200
          );

          const foreignDetail = await call(
            "GET",
            `/api/owner/equipment/${newId}`,
            { token: adminToken }
          );
          ok(
            "Non-Owners cannot use the owner detail route",
            foreignDetail.status === 403 ||
              foreignDetail.status === 404,
            `status ${foreignDetail.status}`
          );

          const editApproved = await call(
            "PATCH",
            `/api/owner/equipment/${newId}`,
            {
              token: ownerToken,
              body: { name: `Smoke Excavator edited ${stamp}` },
            }
          );
          ok(
            "Editing an approved listing returns it to pending",
            editApproved.status === 200 &&
              editApproved.json?.data?.status === "pending",
            `status ${editApproved.status} ${editApproved.json?.data?.status}`
          );

          const removeRejected = await call(
            "DELETE",
            `/api/owner/equipment/${secondId}`,
            { token: ownerToken }
          );
          ok(
            "Owner removes a listing without live rentals",
            removeRejected.status === 200
          );

          const ownerListAfter = await call(
            "GET",
            "/api/owner/equipment",
            { token: ownerToken }
          );
          ok(
            "Removed listing disappears from owner list",
            ownerListAfter.status === 200 &&
              !(ownerListAfter.json?.data ?? []).some(
                (e) => e._id === secondId
              )
          );

          const ownerRequests = await call(
            "GET",
            "/api/bookings/owner/requests",
            { token: ownerToken }
          );
          ok(
            "Owner sees rental requests",
            ownerRequests.status === 200 &&
              Array.isArray(ownerRequests.json?.data)
          );

          // ----- Booking concurrency -----
          // A fresh approved listing with 2 units: five parallel
          // bookings for the same dates must not oversell it.

          const concurrent = await call(
            "POST",
            "/api/owner/equipment",
            {
              token: ownerToken,
              body: {
                name: `Smoke Concurrent ${stamp}`,
                description: "Concurrency probe.",
                category: "Electronics",
                location: "Test City",
                rentalPrice: 50,
                rentalType: "Daily",
                availableQuantity: 2,
                condition: "Good",
                brand: "TestBrand",
                model: "C-2",
                image: "https://example.com/laptop.png",
                rentalTerms: "Return charged.",
              },
            }
          );

          const concurrentId = concurrent.json?.data?._id;

          await call(
            "PATCH",
            `/api/admin/approvals/equipment/${concurrentId}`,
            { token: adminToken, body: { status: "approved" } }
          );

          // Booking requires the Customer role, so demote first.
          const demoteBack = await call(
            "PATCH",
            `/api/admin/users/${target.id}/role`,
            { token: adminToken, body: { role: "Customer" } }
          );
          ok(
            "Admin demotes Owner back to Customer",
            demoteBack.status === 200
          );

          const start = new Date(Date.now() + 45 * 86400000)
            .toISOString()
            .slice(0, 10);
          const end = new Date(Date.now() + 47 * 86400000)
            .toISOString()
            .slice(0, 10);

          const attempts = await Promise.all(
            Array.from({ length: 5 }, () =>
              call("POST", "/api/bookings", {
                token: customerToken,
                body: {
                  equipmentId: concurrentId,
                  quantity: 1,
                  startDate: start,
                  endDate: end,
                },
              })
            )
          );

          const createdCount = attempts.filter(
            (a) => a.status === 201
          ).length;

          ok(
            "Parallel bookings never oversell the stock",
            createdCount >= 1 && createdCount <= 2,
            `created ${createdCount} of 5 → ${attempts
              .map((a) => a.status)
              .join(",")} ${JSON.stringify(
              attempts[0]?.json
            )}`
          );

          // Fill whatever capacity the race left open, then the
          // next booking must be refused.
          let totalCreated = createdCount;

          while (totalCreated < 2) {
            const filler = await call("POST", "/api/bookings", {
              token: customerToken,
              body: {
                equipmentId: concurrentId,
                quantity: 1,
                startDate: start,
                endDate: end,
              },
            });

            if (filler.status !== 201) break;

            totalCreated += 1;
          }

          const extra = await call("POST", "/api/bookings", {
            token: customerToken,
            body: {
              equipmentId: concurrentId,
              quantity: 1,
              startDate: start,
              endDate: end,
            },
          });
          ok(
            "Booking beyond capacity is refused",
            extra.status === 409,
            `status ${extra.status} total ${totalCreated}`
          );

          // ----- Owner booking actions: decline & complete -----
          // Booking creation needs the Customer role while the
          // owner actions need Owner, so every booking is created
          // first and the account is promoted only for the actions.

          const farOut = (offset) =>
            new Date(Date.now() + offset * 86400000)
              .toISOString()
              .slice(0, 10);

          const declineTarget = await call(
            "POST",
            "/api/bookings",
            {
              token: customerToken,
              body: {
                equipmentId: concurrentId,
                quantity: 1,
                startDate: farOut(60),
                endDate: farOut(62),
              },
            }
          );
          ok(
            "Booking created for the decline flow",
            declineTarget.status === 201,
            `status ${declineTarget.status}`
          );

          const declineId = declineTarget.json?.data?.id;

          const completeTarget = await call(
            "POST",
            "/api/bookings",
            {
              token: customerToken,
              body: {
                equipmentId: concurrentId,
                quantity: 1,
                startDate: farOut(70),
                endDate: farOut(72),
              },
            }
          );
          ok(
            "Booking created for the completion flow",
            completeTarget.status === 201,
            `status ${completeTarget.status}`
          );

          const completeId = completeTarget.json?.data?.id;

          // Fixture: settle the booking the way the Stripe
          // webhook would after a successful payment.
          if (completeId) {
            await getDB()
              .collection("booking")
              .updateOne(
                { _id: new ObjectId(completeId) },
                {
                  $set: {
                    status: "confirmed",
                    updatedAt: new Date(),
                  },
                }
              );
          }

          const cancelConfirmedTarget = await call(
            "POST",
            "/api/bookings",
            {
              token: customerToken,
              body: {
                equipmentId: concurrentId,
                quantity: 1,
                startDate: farOut(80),
                endDate: farOut(82),
              },
            }
          );

          const cancelConfirmedId =
            cancelConfirmedTarget.json?.data?.id;

          if (cancelConfirmedId) {
            await getDB()
              .collection("booking")
              .updateOne(
                { _id: new ObjectId(cancelConfirmedId) },
                {
                  $set: {
                    status: "confirmed",
                    updatedAt: new Date(),
                  },
                }
              );
          }

          // Promote for the owner actions below.
          const promotedForActions = await call(
            "PATCH",
            `/api/admin/users/${target.id}/role`,
            { token: adminToken, body: { role: "Owner" } }
          );
          ok(
            "Admin promotes the customer for owner actions",
            promotedForActions.status === 200,
            `status ${promotedForActions.status}`
          );

          if (declineId) {
            const declined = await call(
              "POST",
              `/api/bookings/${declineId}/decline`,
              { token: ownerToken }
            );
            ok(
              "Owner declines a pending request",
              declined.status === 200 &&
                declined.json?.refunded === false,
              `status ${declined.status} ${JSON.stringify(
                declined.json
              )}`
            );

            const declinedView = await call(
              "GET",
              `/api/bookings/${declineId}`,
              { token: customerToken }
            );
            ok(
              "Declined booking is cancelled",
              declinedView.status === 200 &&
                declinedView.json?.data?.status === "cancelled",
              `status ${declinedView.json?.data?.status}`
            );

            const declineAgain = await call(
              "POST",
              `/api/bookings/${declineId}/decline`,
              { token: ownerToken }
            );
            ok(
              "Declining twice is refused",
              declineAgain.status === 404,
              `status ${declineAgain.status}`
            );
          }

          if (completeId) {
            const completed = await call(
              "POST",
              `/api/bookings/${completeId}/complete`,
              { token: ownerToken }
            );
            ok(
              "Owner completes a confirmed rental",
              completed.status === 200,
              `status ${completed.status} ${JSON.stringify(
                completed.json
              )}`
            );

            const completedView = await call(
              "GET",
              `/api/bookings/${completeId}`,
              { token: customerToken }
            );
            ok(
              "Completed booking reports completed",
              completedView.status === 200 &&
                completedView.json?.data?.status === "completed",
              `status ${completedView.json?.data?.status}`
            );

            const completeAgain = await call(
              "POST",
              `/api/bookings/${completeId}/complete`,
              { token: ownerToken }
            );
            ok(
              "Completing twice is refused",
              completeAgain.status === 404,
              `status ${completeAgain.status}`
            );
          }

          if (cancelConfirmedId) {
            const cancelConfirmed = await call(
              "POST",
              `/api/bookings/${cancelConfirmedId}/cancel`,
              { token: customerToken }
            );
            ok(
              "Customer cancels an unpaid confirmed booking",
              cancelConfirmed.status === 200 &&
                cancelConfirmed.json?.refunded === false,
              `status ${cancelConfirmed.status} ${JSON.stringify(
                cancelConfirmed.json
              )}`
            );
          }

          // Back to Customer before the role-management checks.
          await call(
            "PATCH",
            `/api/admin/users/${target.id}/role`,
            { token: adminToken, body: { role: "Customer" } }
          );


          // ----- Role management verification -----

          const rmSelf = users.json?.data?.find(
            (u) => u.email === adminEmail
          );
          const rmOtherAdmin = users.json?.data?.find(
            (u) => u.role === "Admin" && u.id !== rmSelf?.id
          );
          const rmTarget = users.json?.data?.find(
            (u) => u.email === customerEmail
          );

          if (rmTarget) {
            const rmInvalidRole = await call(
              "PATCH",
              `/api/admin/role-management/users/${rmTarget.id}/role`,
              { token: adminToken, body: { role: "Admin" } }
            );
            ok(
              "Role management rejects the Admin role value",
              rmInvalidRole.status === 400,
              `status ${rmInvalidRole.status}`
            );

            const rmToOwner = await call(
              "PATCH",
              `/api/admin/role-management/users/${rmTarget.id}/role`,
              { token: adminToken, body: { role: "Owner" } }
            );
            ok(
              "Role management promotes Customer to Owner",
              rmToOwner.status === 200 &&
                rmToOwner.json?.data?.role === "Owner",
              `status ${rmToOwner.status}`
            );

            const rmToCustomer = await call(
              "PATCH",
              `/api/admin/role-management/users/${rmTarget.id}/role`,
              { token: adminToken, body: { role: "Customer" } }
            );
            ok(
              "Role management demotes Owner to Customer",
              rmToCustomer.status === 200 &&
                rmToCustomer.json?.data?.role === "Customer",
              `status ${rmToCustomer.status}`
            );

            // Optimistic concurrency: two parallel updates race on
            // the stored role. Only 200/409 are acceptable and the
            // target must end up as Owner either way.
            const race = await Promise.all(
              Array.from({ length: 2 }, () =>
                call(
                  "PATCH",
                  `/api/admin/role-management/users/${rmTarget.id}/role`,
                  { token: adminToken, body: { role: "Owner" } }
                )
              )
            );

            const raceStatuses = race.map((r) => r.status);
            const raceOk = raceStatuses.every(
              (status) => status === 200 || status === 409
            );

            ok(
              "Concurrent role updates resolve 200 or 409",
              raceOk && raceStatuses.includes(200),
              `statuses ${raceStatuses.join(",")}`
            );

            const afterRace = (
              await call("GET", "/api/admin/role-management/users", {
                token: adminToken,
              })
            ).json?.data?.find((u) => u.id === rmTarget.id);

            ok(
              "Race winner's role is applied",
              afterRace?.role === "Owner",
              `role ${afterRace?.role}`
            );

            await call(
              "PATCH",
              `/api/admin/role-management/users/${rmTarget.id}/role`,
              { token: adminToken, body: { role: "Customer" } }
            );
          }

          if (rmSelf) {
            const rmSelfChange = await call(
              "PATCH",
              `/api/admin/role-management/users/${rmSelf.id}/role`,
              { token: adminToken, body: { role: "Customer" } }
            );
            ok(
              "Role management refuses self-modification",
              rmSelfChange.status === 403,
              `status ${rmSelfChange.status}`
            );
          }

          if (rmOtherAdmin) {
            const rmAdminTarget = await call(
              "PATCH",
              `/api/admin/role-management/users/${rmOtherAdmin.id}/role`,
              { token: adminToken, body: { role: "Customer" } }
            );
            ok(
              "Role management refuses Admin accounts",
              rmAdminTarget.status === 403,
              `status ${rmAdminTarget.status}`
            );
          }

          const rmUnknown = await call(
            "PATCH",
            `/api/admin/role-management/users/${"0".repeat(24)}/role`,
            { token: adminToken, body: { role: "Owner" } }
          );
          ok(
            "Role management returns 404 for an unknown user",
            rmUnknown.status === 404,
            `status ${rmUnknown.status}`
          );

          if (target) {
            const badRoleValue = await call(
              "PATCH",
              `/api/admin/users/${target.id}/role`,
              { token: adminToken, body: { role: "Superuser" } }
            );
            ok(
              "Admin role route rejects an invalid role",
              badRoleValue.status === 400,
              `status ${badRoleValue.status}`
            );
          }
        }
      }
    } finally {
      if (provisionedAdminEmail) {
        try {
          const users = getDB().collection("user");
          const doc = await users.findOne({
            email: provisionedAdminEmail,
          });

          if (doc) {
            await users.updateOne(
              { _id: doc._id },
              {
                $set: {
                  role: "Customer",
                  updatedAt: new Date(),
                },
              }
            );

            await getDB()
              .collection("session")
              .deleteMany({ userId: doc._id });
          }

          console.log(
            "  INFO  throwaway Admin demoted back to " +
              "Customer and sessions revoked"
          );
        } catch (error) {
          console.error(
            "  WARN  throwaway admin cleanup failed:",
            error?.message
          );
        }
      }
    }
  }

  // ---------- Report ----------
  console.log(`\n${passed} passed, ${failed} failed`);

  if (skipped.length) {
    console.log(`Skipped: ${skipped.length}`);
    for (const item of skipped) console.log(`  - ${item}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
