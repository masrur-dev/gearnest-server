
// Stripe helpers shared by the checkout, webhook, booking and
// success-page flows. Everything takes `db` as an argument so the
// module never touches the global connection itself.

import Stripe from "stripe";
import { ObjectId } from "mongodb";

const BOOKING_COLLECTION = "booking";
const PAYMENT_COLLECTION = "payment";

// Lazy: the app must boot without Stripe keys. Payment endpoints
// answer 503 until STRIPE_SECRET_KEY is configured.
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) {
    return null;
  }

  return new Stripe(key);
}

export async function retireOpenCheckoutSession(
  stripe,
  sessionId
) {
  let expirationError = null;

  try {
    const result =
      await stripe.checkout.sessions.expire(sessionId);

    if (
      result.status === "expired" ||
      result.status === "complete"
    ) {
      return result.status;
    }
  } catch (error) {
    expirationError = error;
  }

  const current =
    await stripe.checkout.sessions.retrieve(sessionId);

  if (
    current.status === "expired" ||
    current.status === "complete"
  ) {
    return current.status;
  }

  if (expirationError) {
    throw expirationError;
  }

  throw new Error(
    "Checkout Session remains open after expiration request"
  );
}

export function amountInCents(booking) {
  const amount = Math.round(
    Number(booking.totalAmount) * 100
  );

  if (
    !Number.isSafeInteger(amount) ||
    amount < 50 ||
    amount > 99999999
  ) {
    return null;
  }

  return amount;
}

function sessionMatchesBooking(booking, session) {
  const bookingId = String(booking._id);

  return (
    session.mode === "payment" &&
    session.client_reference_id === bookingId &&
    session.metadata?.bookingId === bookingId
  );
}

// ====================================
// REFUND
// ====================================
// Marks the payment record refunded and (optionally) the booking
// paymentStatus. Every failure is loud: money that could not be
// returned must be visible in the logs for reconciliation.

export async function refundBookingPayment({
  db,
  booking,
  session = null,
  payment = null,
  reason = "requested_by_customer",
  context = "refund",
  updateBooking = true,
}) {
  const stripe = getStripe();
  const bookings = db.collection(BOOKING_COLLECTION);
  const payments = db.collection(PAYMENT_COLLECTION);

  if (!stripe) {
    console.error(
      "RECONCILIATION: refund skipped, Stripe not configured.",
      { context, bookingId: String(booking._id) }
    );

    return {
      refunded: false,
      reason: "stripe_not_configured",
    };
  }

  let paymentDoc = payment ?? null;

  // Prefer the session that carries the money: for duplicate or
  // late settlements it differs from the booking's stored session.
  if (!paymentDoc && session?.id) {
    paymentDoc = await payments.findOne({
      stripeSessionId: session.id,
    });
  }

  if (!paymentDoc && booking.stripeSessionId) {
    paymentDoc = await payments.findOne({
      stripeSessionId: booking.stripeSessionId,
    });
  }

  if (!paymentDoc) {
    paymentDoc = await payments.findOne({
      bookingId:
        booking._id instanceof ObjectId
          ? booking._id
          : new ObjectId(booking._id),
      status: "paid",
    });
  }

  if (
    booking.paymentStatus === "refunded" ||
    paymentDoc?.status === "refunded"
  ) {
    return {
      refunded: false,
      reason: "already_refunded",
    };
  }

  let paymentIntentId =
    session?.payment_intent ??
    booking.stripePaymentIntentId ??
    paymentDoc?.stripePaymentIntentId ??
    null;

  if (!paymentIntentId && booking.stripeSessionId) {
    try {
      const checkout =
        await stripe.checkout.sessions.retrieve(
          booking.stripeSessionId
        );

      paymentIntentId = checkout.payment_intent ?? null;
    } catch (error) {
      console.error(
        "Refund session lookup:",
        error.message
      );
    }
  }

  if (!paymentIntentId) {
    console.error(
      "RECONCILIATION: no payment intent to refund.",
      { context, bookingId: String(booking._id) }
    );

    return {
      refunded: false,
      reason: "no_payment_intent",
    };
  }

  let refundError = null;

  try {
    await stripe.refunds.create(
      { payment_intent: paymentIntentId, reason },
      { idempotencyKey: `refund_${paymentIntentId}` }
    );
  } catch (error) {
    const already =
      error?.code === "charge_already_refunded" ||
      /already refunded/i.test(error?.message ?? "");

    if (!already) {
      // Maybe an earlier refund attempt succeeded.
      const existing = await stripe.refunds
        .list({ payment_intent: paymentIntentId, limit: 10 })
        .catch(() => null);

      const succeeded = existing?.data?.find(
        (item) => item.status === "succeeded"
      );

      if (!succeeded) {
        refundError = error;
      }
    }
  }

  if (refundError) {
    console.error("RECONCILIATION: refund failed.", {
      context,
      bookingId: String(booking._id),
      paymentIntentId,
      error: refundError.message,
    });

    if (paymentDoc) {
      await payments.updateOne(
        { _id: paymentDoc._id },
        {
          $set: {
            status: "paid",
            refundStatus: "failed",
            refundError: String(refundError.message).slice(
              0,
              300
            ),
            updatedAt: new Date(),
          },
        }
      );
    }

    return {
      refunded: false,
      reason: "stripe_error",
    };
  }

  const now = new Date();

  if (paymentDoc) {
    await payments.updateOne(
      { _id: paymentDoc._id },
      {
        $set: {
          status: "refunded",
          refundedAt: now,
          updatedAt: now,
        },
        $unset: { refundStatus: "", refundError: "" },
      }
    );
  } else if (session?.id) {
    await payments.updateOne(
      { stripeSessionId: session.id },
      {
        $set: {
          status: "refunded",
          refundedAt: now,
          updatedAt: now,
        },
      }
    );
  }

  if (updateBooking) {
    await bookings.updateOne(
      {
        _id: booking._id instanceof ObjectId
          ? booking._id
          : new ObjectId(booking._id),
        paymentStatus: { $ne: "refunded" },
      },
      {
        $set: {
          paymentStatus: "refunded",
          updatedAt: now,
        },
      }
    );
  }

  console.log(
    `Refund succeeded (${context}):`,
    String(booking._id)
  );

  return { refunded: true };
}

// ====================================
// EXPIRE CHECKOUT SESSION
// ====================================
// Retires an open session when a booking is cancelled or replaced.
// If Stripe says the money already arrived, the caller must refund.

export async function expireCheckoutSession(
  stripe,
  sessionId
) {
  if (!stripe || !sessionId) {
    return { status: "none" };
  }

  try {
    await stripe.checkout.sessions.expire(sessionId);
    return { status: "expired" };
  } catch {
    try {
      const session =
        await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status === "paid") {
        return { status: "paid", session };
      }

      if (session.status === "expired") {
        return { status: "expired", session };
      }

      return {
        status: session.status ?? "unknown",
        session,
      };
    } catch (retrieveError) {
      console.error(
        "Session expire/lookup failed:",
        retrieveError.message
      );

      return {
        status: "unknown",
        error: retrieveError.message,
      };
    }
  }
}

// ====================================
// SETTLE A PAID SESSION
// ====================================
// Single decision point for money that arrived through Stripe:
// confirm the booking, ignore a duplicate settlement, refund a
// duplicate charge, or refund a late payment on a booking that is
// no longer payable. Never returns a client error.

export async function settlePaidSession({
  db,
  booking,
  session,
}) {
  const bookings = db.collection(BOOKING_COLLECTION);
  const payments = db.collection(PAYMENT_COLLECTION);
  const now = new Date();
  const bookingId = String(booking._id);

  if (!sessionMatchesBooking(booking, session)) {
    return { outcome: "invalid_reference" };
  }

  // Keep the payment record in sync for dashboards and history.
  await payments.updateOne(
    { stripeSessionId: session.id },
    {
      $set: {
        bookingId: booking._id,
        userId: booking.customerId ?? "",
        amount: Number(booking.totalAmount),
        currency: session.currency,
        stripePaymentIntentId:
          session.payment_intent ?? null,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
        status: "pending",
      },
    },
    { upsert: true }
  );

  if (session.payment_status !== "paid") {
    // Completed but money not captured yet (async methods).
    await payments.updateOne(
      { stripeSessionId: session.id, status: "pending" },
      {
        $set: {
          status: "processing",
          updatedAt: now,
        },
      }
    );

    return { outcome: "awaiting_payment" };
  }

  const expected = amountInCents(booking);
  const verified =
    expected !== null &&
    session.amount_total === expected &&
    session.currency === "usd";

  if (
    verified &&
    booking.stripeSessionId === session.id
  ) {
    const result = await bookings.updateOne(
      {
        _id: booking._id,
        stripeSessionId: session.id,
        status: "pending_payment",
        paymentStatus: { $ne: "paid" },
      },
      {
        $set: {
          status: "confirmed",
          paymentStatus: "paid",
          paidAt: now,
          stripePaymentIntentId:
            session.payment_intent ?? null,
          updatedAt: now,
        },
      }
    );

    if (result.modifiedCount) {
      await payments.updateOne(
        {
          stripeSessionId: session.id,
          status: { $ne: "refunded" },
        },
        { $set: { status: "paid", updatedAt: now } }
      );

      console.log("Payment confirmed:", bookingId);

      return { outcome: "confirmed" };
    }
  }

  // Guard failed: re-read and decide from fresh state.
  const fresh = await bookings.findOne({
    _id: booking._id instanceof ObjectId
      ? booking._id
      : new ObjectId(booking._id),
  });

  if (!fresh) {
    return { outcome: "booking_missing" };
  }

  if (fresh.paymentStatus === "paid") {
    if (fresh.stripeSessionId === session.id) {
      // Same session already settled: idempotent no-op.
      await payments.updateOne(
        {
          stripeSessionId: session.id,
          status: { $ne: "refunded" },
        },
        { $set: { status: "paid", updatedAt: now } }
      );

      return { outcome: "already_settled" };
    }

    // A different session paid the same booking: the extra
    // session is a duplicate charge and must come back.
    console.error(
      "DUPLICATE CHARGE: refunding session",
      session.id,
      "for booking",
      bookingId
    );

    const refund = await refundBookingPayment({
      db,
      booking: fresh,
      session,
      reason: "duplicate",
      context: "duplicate-session",
      updateBooking: false,
    });

    return {
      outcome: refund.refunded
        ? "duplicate_refunded"
        : "duplicate_refund_failed",
    };
  }

  if (fresh.status === "pending_payment") {
    if (verified && fresh.stripeSessionId !== session.id) {
      // Verified stale session: the session id moved on (the
      // booking was re-pointed) but this one really paid.
      const previous = fresh.stripeSessionId;

      const stale = await bookings.updateOne(
        {
          _id: fresh._id,
          status: "pending_payment",
          paymentStatus: { $ne: "paid" },
        },
        {
          $set: {
            status: "confirmed",
            paymentStatus: "paid",
            paidAt: now,
            stripeSessionId: session.id,
            stripePaymentIntentId:
              session.payment_intent ?? null,
            updatedAt: now,
          },
        }
      );

      if (stale.modifiedCount) {
        if (previous) {
          await payments.updateOne(
            {
              stripeSessionId: previous,
              status: { $in: ["pending", "processing"] },
            },
            {
              $set: {
                status: "expired",
                updatedAt: now,
              },
            }
          );
        }

        await payments.updateOne(
          {
            stripeSessionId: session.id,
            status: { $ne: "refunded" },
          },
          {
            $set: { status: "paid", updatedAt: now },
          }
        );

        console.log(
          "Payment confirmed (stale session superseded):",
          bookingId
        );

        return { outcome: "confirmed_stale_session" };
      }

      return { outcome: "reconciliation" };
    }

    console.error(
      "RECONCILIATION: paid session cannot be verified.",
      {
        bookingId,
        session: session.id,
        storedSession: fresh.stripeSessionId,
        amountTotal: session.amount_total,
        expected,
      }
    );

    return { outcome: "reconciliation" };
  }

  // Late payment: the booking is no longer payable.
  console.error(
    "LATE PAYMENT: refunding session",
    session.id,
    "for booking",
    bookingId,
    "status",
    fresh.status
  );

  const refund = await refundBookingPayment({
    db,
    booking: fresh,
    session,
    reason: "requested_by_customer",
    context: "late-payment",
    updateBooking: true,
  });

  return {
    outcome: refund.refunded
      ? "late_refunded"
      : "late_refund_failed",
  };
}

// ====================================
// CANCELLED BOOKING CLEANUP
// ====================================
// After a booking is cancelled or declined: refund it when it was
// paid, otherwise retire its open Checkout Session so the payment
// history does not stay pending forever.

export async function handleCancelledBooking({
  db,
  booking,
  context = "cancel",
}) {
  const payments = db.collection(PAYMENT_COLLECTION);

  if (booking.paymentStatus === "paid") {
    const refund = await refundBookingPayment({
      db,
      booking,
      reason: "requested_by_customer",
      context,
      updateBooking: true,
    });

    return { refunded: refund.refunded };
  }

  if (booking.stripeSessionId) {
    const stripe = getStripe();
    const outcome = await expireCheckoutSession(
      stripe,
      booking.stripeSessionId
    );

    if (outcome.status === "paid") {
      // Charged moments before the cancellation: give it back.
      const refund = await refundBookingPayment({
        db,
        booking,
        session: outcome.session,
        reason: "requested_by_customer",
        context,
        updateBooking: true,
      });

      return { refunded: refund.refunded };
    }

    if (
      outcome.status === "expired" ||
      outcome.status === "none"
    ) {
      await payments.updateOne(
        {
          stripeSessionId: booking.stripeSessionId,
          status: { $in: ["pending", "processing"] },
        },
        {
          $set: {
            status: "expired",
            updatedAt: new Date(),
          },
        }
      );
    } else if (outcome.status !== "complete") {
      console.error(
        "RECONCILIATION: unexpected session state",
        outcome.status,
        "for booking",
        String(booking._id)
      );
    }
  }

  return { refunded: false };
}
