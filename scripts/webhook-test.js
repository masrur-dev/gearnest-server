
// Stripe webhook verification test (no Stripe account or network
// needed — events are HMAC-signed locally exactly like Stripe).
//
//   npm run test:webhook
//
// Spawns the server on port 5010 with a throwaway webhook secret,
// creates real bookings, simulates their checkout session ids,
// then delivers signed fixture events:
//
//   1. invalid signature            -> 400, booking untouched
//   2. checkout.session.completed   -> 200, booking confirmed,
//                                      payment doc written (DB proof)
//   3. redelivery of the same event -> 200 duplicate, no side effects
//      dashboard                     -> real confirmed/upcoming counts
//   4. checkout.session.expired     -> 200, booking expired
//   5. charge.refunded              -> 200, booking refunded
//   6. booking detail               -> paymentStatus exposed
//   7. bad booking reference        -> 400, marker released
//   8. stale session (id moved on)  -> confirmed, old doc expired
//   9. same session, new event id   -> no-op, payment untouched
//  10. duplicate paid session       -> refund attempted, failure kept
//  11. late payment after cancel    -> booking stays cancelled
//
// Cleans up every booking/payment document it created.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";

import "dotenv/config";

const PORT = 5010;
const BASE = `http://localhost:${PORT}`;
const SECRET = "whsec_local_webhook_test";

const ORIGIN = process.env.CLIENT_URL || "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Stripe's signature scheme: HMAC-SHA256 over `${timestamp}.${payload}`.
function stripeSignature(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(`${timestamp}.${payload}`);

  return `t=${timestamp},v1=${hmac.digest("hex")}`;
}

async function call(method, path, { token, body } = {}) {
  const headers = { origin: ORIGIN };

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

  return { status: response.status, json };
}

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

async function postWebhook(payloadObj, signature) {
  const payload = JSON.stringify(payloadObj);

  const response = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature ?? stripeSignature(payload),
    },
    body: payload,
  });

  let json;

  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, json, text: await response.text().catch(() => "") };
}

async function startServer() {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("../index.js", import.meta.url))],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(PORT),
        STRIPE_SECRET_KEY:
          process.env.STRIPE_SECRET_KEY || "sk_test_local_dummy",
        STRIPE_WEBHOOK_SECRET: SECRET,
      },
    }
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

async function main() {
  const { connectDB, getDB } = await import("../config/db.js");

  const server = await startServer();
  await connectDB();

  const db = getDB();
  const bookings = db.collection("booking");
  const payments = db.collection("payment");

  const createdBookingIds = [];
  const createdSessionIds = [];
  const createdEventIds = [];

  try {
    console.log(`\nGearNest webhook verification → ${BASE}\n`);

    // ---------- Fixture: customer + booking ----------
    const stamp = Date.now();
    const email = `webhook.test.${stamp}@example.com`;

    const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        password: "SmokeTest!123",
        name: "Webhook Tester",
      }),
    });

    const token = await toJwt(signup.headers.get("set-cookie"));

    ok("Test customer registered", Boolean(token));

    const list = await call("GET", "/api/equipment");
    const equipment = (list.json?.data ?? []).find(
      (e) => e.availableQuantity >= 2
    );

    ok(
      "Approved equipment with 2+ units available",
      Boolean(equipment)
    );

    if (!token || !equipment) {
      throw new Error("Fixture setup failed");
    }

    const startDate = new Date(Date.now() + 90 * 86400000)
      .toISOString()
      .slice(0, 10);
    const endDate = new Date(Date.now() + 92 * 86400000)
      .toISOString()
      .slice(0, 10);

    const created = await call("POST", "/api/bookings", {
      token,
      body: {
        equipmentId: equipment._id,
        quantity: 1,
        startDate,
        endDate,
      },
    });

    const bookingId = created.json?.data?.id;

    ok(
      "Booking fixture created",
      created.status === 201 && Boolean(bookingId),
      `status ${created.status} ${JSON.stringify(created.json)}`
    );

    if (!bookingId) throw new Error("No booking id");

    createdBookingIds.push(bookingId);

    // Simulate what POST /create-checkout-session stores: the
    // webhook refuses events whose session id does not match.
    const sessionId = `cs_local_${stamp}`;
    const paymentIntent = `pi_local_${stamp}`;
    createdSessionIds.push(sessionId);

    const rawBooking = await bookings.findOne({
      _id: new ObjectId(bookingId),
    });

    const amountTotal = Math.round(
      Number(rawBooking.totalAmount) * 100
    );

    await bookings.updateOne(
      { _id: rawBooking._id },
      {
        $set: {
          stripeSessionId: sessionId,
          paymentStatus: "pending",
          updatedAt: new Date(),
        },
      }
    );

    // ---------- 1. Invalid signature ----------
    const completedEvent = {
      id: `evt_local_${stamp}_completed`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          client_reference_id: bookingId,
          payment_status: "paid",
          payment_intent: paymentIntent,
          amount_total: amountTotal,
          currency: "usd",
          metadata: { bookingId },
        },
      },
    };

    createdEventIds.push(completedEvent.id);

    const badSig = await postWebhook(
      completedEvent,
      "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );

    ok(
      "Invalid signature is rejected with 400",
      badSig.status === 400,
      `status ${badSig.status}`
    );

    let booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
    });

    ok(
      "Booking untouched after bad signature",
      booking?.status === "pending_payment",
      `status ${booking?.status}`
    );

    // ---------- 2. Valid completed event ----------
    const good = await postWebhook(completedEvent);

    ok(
      "Signed webhook accepted",
      good.status === 200 && good.json?.received === true,
      `status ${good.status} ${JSON.stringify(good.json)}`
    );

    booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
    });

    ok(
      "Payment confirmed the booking (pending_payment → confirmed)",
      booking?.status === "confirmed" &&
        booking?.paymentStatus === "paid",
      `status ${booking?.status} paymentStatus ${booking?.paymentStatus}`
    );

    const paymentDoc = await payments.findOne({
      stripeSessionId: sessionId,
    });

    ok(
      "DB: payment record written with amount and status paid",
      Boolean(paymentDoc) &&
        paymentDoc.status === "paid" &&
        paymentDoc.amount ===
          Number(rawBooking.totalAmount) &&
        String(paymentDoc.userId) === String(booking.customerId),
      JSON.stringify(paymentDoc ?? null)
    );

    ok(
      "DB: webhook event stored as processed",
      (await payments.findOne({
        stripeEventId: completedEvent.id,
      }))?.status === "processed",
      "event marker missing or not processed"
    );

    // ---------- 3. Redelivery of the same event ----------
    const replay = await postWebhook(completedEvent);

    ok(
      "Redelivered event is flagged duplicate",
      replay.status === 200 && replay.json?.duplicate === true,
      `status ${replay.status} ${JSON.stringify(replay.json)}`
    );

    booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
    });

    ok(
      "Redelivery did not change the confirmed booking",
      booking?.status === "confirmed",
      `status ${booking?.status}`
    );

    ok(
      "Redelivery did not duplicate the payment record",
      (await payments.countDocuments({
        stripeSessionId: sessionId,
      })) === 1,
      "expected exactly one payment doc"
    );

    // ---------- 3b. Customer dashboard sees real data ----------
    const dashboard = await call(
      "GET",
      "/api/dashboard/customer",
      { token }
    );

    ok(
      "Dashboard reports the confirmed booking",
      dashboard.status === 200 &&
        (dashboard.json?.stats?.byStatus?.confirmed ?? 0) >= 1 &&
        Array.isArray(dashboard.json?.upcoming) &&
        dashboard.json.upcoming.some(
          (b) => b.id === bookingId
        ),
      `status ${dashboard.status} ${JSON.stringify(
        dashboard.json?.stats?.byStatus
      )}`
    );

    // ---------- 4. Expired session (second booking) ----------
    const created2 = await call("POST", "/api/bookings", {
      token,
      body: {
        equipmentId: equipment._id,
        quantity: 1,
        startDate,
        endDate,
      },
    });

    const booking2Id = created2.json?.data?.id;

    ok(
      "Second booking fixture created",
      created2.status === 201 && Boolean(booking2Id),
      `status ${created2.status}`
    );

    if (booking2Id) {
      createdBookingIds.push(booking2Id);

      const sessionId2 = `cs_local_${stamp}_2`;
      createdSessionIds.push(sessionId2);

      const raw2 = await bookings.findOne({
        _id: new ObjectId(booking2Id),
      });

      await bookings.updateOne(
        { _id: raw2._id },
        {
          $set: {
            stripeSessionId: sessionId2,
            paymentStatus: "pending",
          },
        }
      );

      const expiredEvent = {
        id: `evt_local_${stamp}_expired`,
        type: "checkout.session.expired",
        data: {
          object: {
            id: sessionId2,
            mode: "payment",
            client_reference_id: booking2Id,
            payment_status: "unpaid",
            amount_total: Math.round(
              Number(raw2.totalAmount) * 100
            ),
            currency: "usd",
            metadata: { bookingId: booking2Id },
          },
        },
      };

      createdEventIds.push(expiredEvent.id);

      const expired = await postWebhook(expiredEvent);

      const booking2 = await bookings.findOne({
        _id: new ObjectId(booking2Id),
      });

      ok(
        "Expired session event expires the booking",
        expired.status === 200 && booking2?.status === "expired",
        `status ${expired.status}, booking ${booking2?.status}`
      );

      // ---------- 5. Refund of the paid booking ----------
      const refundEvent = {
        id: `evt_local_${stamp}_refund`,
        type: "charge.refunded",
        data: {
          object: {
            id: `ch_local_${stamp}`,
            payment_intent: paymentIntent,
            amount_refunded: amountTotal,
            currency: "usd",
          },
        },
      };

      createdEventIds.push(refundEvent.id);

      const refunded = await postWebhook(refundEvent);

      booking = await bookings.findOne({
        _id: new ObjectId(bookingId),
      });

      ok(
        "Refund event refunds the confirmed booking",
        refunded.status === 200 && booking?.status === "refunded",
        `status ${refunded.status}, booking ${booking?.status}`
      );

      ok(
        "DB: payment marked refunded",
        (await payments.findOne({
          stripeSessionId: sessionId,
        }))?.status === "refunded",
        "payment not refunded"
      );
    }

    // ---------- 6. Booking detail exposes payment status ----------
    const detail = await call(
      "GET",
      `/api/bookings/${bookingId}`,
      { token }
    );

    ok(
      "Booking detail exposes paymentStatus",
      detail.status === 200 &&
        detail.json?.data?.paymentStatus === "refunded",
      `status ${detail.status} paymentStatus ${
        detail.json?.data?.paymentStatus
      }`
    );

    // ---------- 7. Bad booking reference ----------
    // A rejected event must release its idempotency marker,
    // otherwise Stripe's retry would be skipped as duplicate.
    const badRefEvent = {
      id: `evt_local_${stamp}_badref`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_local_${stamp}_badref`,
          mode: "payment",
          client_reference_id: bookingId,
          payment_status: "paid",
          payment_intent: `pi_local_${stamp}_badref`,
          amount_total: amountTotal,
          currency: "usd",
          metadata: { bookingId: "b".repeat(24) },
        },
      },
    };

    createdEventIds.push(badRefEvent.id);

    const badRef1 = await postWebhook(badRefEvent);

    ok(
      "Mismatched booking reference is rejected with 400",
      badRef1.status === 400,
      `status ${badRef1.status}`
    );

    const badRef2 = await postWebhook(badRefEvent);

    ok(
      "Rejected event can be retried (marker released)",
      badRef2.status === 400 &&
        badRef2.json?.duplicate !== true,
      `status ${badRef2.status} ${JSON.stringify(
        badRef2.json
      )}`
    );

    // ---------- 8. Stale session supersedes ----------
    // The booking points at session A, but session B (same
    // reference, same amount) is the one that was charged.
    const created3 = await call("POST", "/api/bookings", {
      token,
      body: {
        equipmentId: equipment._id,
        quantity: 1,
        startDate: new Date(Date.now() + 100 * 86400000)
          .toISOString()
          .slice(0, 10),
        endDate: new Date(Date.now() + 102 * 86400000)
          .toISOString()
          .slice(0, 10),
      },
    });

    const booking3Id = created3.json?.data?.id;

    ok(
      "Third booking fixture created",
      created3.status === 201 && Boolean(booking3Id),
      `status ${created3.status}`
    );

    if (booking3Id) {
      createdBookingIds.push(booking3Id);

      const sessionId3a = `cs_local_${stamp}_3a`;
      const sessionId3b = `cs_local_${stamp}_3b`;
      const sessionId3dup = `cs_local_${stamp}_3dup`;

      createdSessionIds.push(
        sessionId3a,
        sessionId3b,
        sessionId3dup
      );

      const raw3 = await bookings.findOne({
        _id: new ObjectId(booking3Id),
      });

      const amount3 = Math.round(
        Number(raw3.totalAmount) * 100
      );

      await bookings.updateOne(
        { _id: raw3._id },
        {
          $set: {
            stripeSessionId: sessionId3a,
            paymentStatus: "pending",
          },
        }
      );

      // The checkout-created record for the session A.
      await payments.updateOne(
        { stripeSessionId: sessionId3a },
        {
          $setOnInsert: {
            bookingId: raw3._id,
            userId: raw3.customerId,
            amount: Number(raw3.totalAmount),
            currency: "usd",
            status: "pending",
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );

      const staleEvent = {
        id: `evt_local_${stamp}_stale`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId3b,
            mode: "payment",
            client_reference_id: booking3Id,
            payment_status: "paid",
            payment_intent: `pi_local_${stamp}_3b`,
            amount_total: amount3,
            currency: "usd",
            metadata: { bookingId: booking3Id },
          },
        },
      };

      createdEventIds.push(staleEvent.id);

      const stale = await postWebhook(staleEvent);
      const booking3 = await bookings.findOne({
        _id: new ObjectId(booking3Id),
      });

      ok(
        "Stale-session payment still confirms the booking",
        stale.status === 200 &&
          stale.json?.outcome === "confirmed_stale_session" &&
          booking3?.status === "confirmed" &&
          booking3?.paymentStatus === "paid" &&
          booking3?.stripeSessionId === sessionId3b,
        `status ${stale.status} outcome ${
          stale.json?.outcome
        } booking ${booking3?.status}/${
          booking3?.paymentStatus
        }/${booking3?.stripeSessionId}`
      );

      ok(
        "Superseded payment record is expired",
        (await payments.findOne({
          stripeSessionId: sessionId3a,
        }))?.status === "expired",
        "session A payment doc not expired"
      );

      ok(
        "New session payment record is paid",
        (await payments.findOne({
          stripeSessionId: sessionId3b,
        }))?.status === "paid",
        "session B payment doc not paid"
      );

      // ---------- 9. Same session, new event id ----------
      const settledAgain = {
        id: `evt_local_${stamp}_stale_replay`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId3b,
            mode: "payment",
            client_reference_id: booking3Id,
            payment_status: "paid",
            payment_intent: `pi_local_${stamp}_3b`,
            amount_total: amount3,
            currency: "usd",
            metadata: { bookingId: booking3Id },
          },
        },
      };

      createdEventIds.push(settledAgain.id);

      const noop = await postWebhook(settledAgain);

      ok(
        "Settling an already-paid session is a no-op",
        noop.status === 200 &&
          noop.json?.outcome === "already_settled",
        `status ${noop.status} outcome ${
          noop.json?.outcome
        }`
      );

      const pay3b = await payments.findOne({
        stripeSessionId: sessionId3b,
      });

      ok(
        "No-op did not refund or alter the payment",
        pay3b?.status === "paid" &&
          pay3b?.refundedAt === undefined,
        `status ${pay3b?.status}`
      );

      // ---------- 10. Duplicate charge ----------
      // A second paid session for the same booking must be
      // refunded, and the failure recorded for reconciliation.
      const dupEvent = {
        id: `evt_local_${stamp}_dup`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId3dup,
            mode: "payment",
            client_reference_id: booking3Id,
            payment_status: "paid",
            payment_intent: `pi_local_${stamp}_3dup`,
            amount_total: amount3,
            currency: "usd",
            metadata: { bookingId: booking3Id },
          },
        },
      };

      createdEventIds.push(dupEvent.id);

      const dup = await postWebhook(dupEvent);
      const booking3b = await bookings.findOne({
        _id: new ObjectId(booking3Id),
      });

      ok(
        "Duplicate charge triggers a refund attempt",
        dup.status === 200 &&
          dup.json?.outcome === "duplicate_refund_failed",
        `status ${dup.status} outcome ${
          dup.json?.outcome
        }`
      );

      const dupDoc = await payments.findOne({
        stripeSessionId: sessionId3dup,
      });

      ok(
        "Duplicate payment kept for reconciliation",
        Boolean(dupDoc) &&
          dupDoc.status === "paid" &&
          dupDoc.refundStatus === "failed",
        JSON.stringify(dupDoc ?? null)
      );

      ok(
        "Original booking untouched by duplicate refund",
        booking3b?.status === "confirmed" &&
          booking3b?.paymentStatus === "paid" &&
          booking3b?.stripeSessionId === sessionId3b,
        `booking ${booking3b?.status}/${
          booking3b?.paymentStatus
        }/${booking3b?.stripeSessionId}`
      );

      // ---------- 11. Late payment after cancellation ----------
      const created4 = await call("POST", "/api/bookings", {
        token,
        body: {
          equipmentId: equipment._id,
          quantity: 1,
          startDate: new Date(Date.now() + 105 * 86400000)
            .toISOString()
            .slice(0, 10),
          endDate: new Date(Date.now() + 107 * 86400000)
            .toISOString()
            .slice(0, 10),
        },
      });

      const booking4Id = created4.json?.data?.id;

      ok(
        "Fourth booking fixture created",
        created4.status === 201 && Boolean(booking4Id),
        `status ${created4.status}`
      );

      if (booking4Id) {
        createdBookingIds.push(booking4Id);

        const sessionId4 = `cs_local_${stamp}_4`;
        createdSessionIds.push(sessionId4);

        const raw4 = await bookings.findOne({
          _id: new ObjectId(booking4Id),
        });

        await bookings.updateOne(
          { _id: raw4._id },
          {
            $set: {
              stripeSessionId: sessionId4,
              paymentStatus: "pending",
            },
          }
        );

        const cancel4 = await call(
          "POST",
          `/api/bookings/${booking4Id}/cancel`,
          { token }
        );

        ok(
          "Customer cancels the unpaid booking",
          cancel4.status === 200 &&
            cancel4.json?.refunded === false &&
            cancel4.json?.message === "Booking cancelled",
          `status ${cancel4.status} ${JSON.stringify(
            cancel4.json
          )}`
        );

        // Money arrives after the cancellation anyway.
        const lateEvent = {
          id: `evt_local_${stamp}_late`,
          type: "checkout.session.completed",
          data: {
            object: {
              id: sessionId4,
              mode: "payment",
              client_reference_id: booking4Id,
              payment_status: "paid",
              payment_intent: `pi_local_${stamp}_4`,
              amount_total: Math.round(
                Number(raw4.totalAmount) * 100
              ),
              currency: "usd",
              metadata: { bookingId: booking4Id },
            },
          },
        };

        createdEventIds.push(lateEvent.id);

        const late = await postWebhook(lateEvent);
        const booking4 = await bookings.findOne({
          _id: new ObjectId(booking4Id),
        });

        ok(
          "Late payment does not resurrect the booking",
          late.status === 200 &&
            late.json?.outcome === "late_refund_failed" &&
            booking4?.status === "cancelled",
          `status ${late.status} outcome ${
            late.json?.outcome
          } booking ${booking4?.status}`
        );

        const pay4 = await payments.findOne({
          stripeSessionId: sessionId4,
        });

        ok(
          "Late charge kept for reconciliation",
          Boolean(pay4) &&
            pay4.status === "paid" &&
            pay4.refundStatus === "failed",
          JSON.stringify(pay4 ?? null)
        );

        ok(
          "Failed refund leaves paymentStatus untouched",
          booking4?.paymentStatus !== "refunded",
          `paymentStatus ${booking4?.paymentStatus}`
        );
      }
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    // ---------- Cleanup ----------
    try {
      await payments.deleteMany({
        $or: [
          { stripeSessionId: { $in: createdSessionIds } },
          { stripeEventId: { $in: createdEventIds } },
        ],
      });

      await bookings.deleteMany({
        _id: {
          $in: createdBookingIds.map((id) => new ObjectId(id)),
        },
      });
    } catch (error) {
      console.error("Cleanup failed:", error?.message);
    }

    server.kill();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error("Webhook test crashed:", error);
    process.exit(1);
  });
