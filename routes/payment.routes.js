
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getDB } from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import {
  getStripe,
  settlePaidSession,
} from "../services/stripe-services.js";

const router = Router();

function paymentsDisabled(res) {
  return res.status(503).json({
    success: false,
    message: "Payments are not configured",
  });
}

// ========================================
// GET /api/payments/session/:sessionId
//
// The success page must never trust a redirect alone: it asks
// the server, which reads the session state from Stripe.
// ========================================
router.get(
  "/session/:sessionId",
  verifyToken,
  async (req, res) => {
    try {
      const stripe = getStripe();

      if (!stripe) {
        return paymentsDisabled(res);
      }

      const { sessionId } = req.params;

      if (
        typeof sessionId !== "string" ||
        !sessionId.startsWith("cs_")
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid session ID",
        });
      }

      const db = getDB();

      const payment = await db
        .collection("payment")
        .findOne({ stripeSessionId: sessionId });

      if (!payment || payment.userId !== req.user.id) {
        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      const session =
        await stripe.checkout.sessions.retrieve(sessionId);

      let booking = payment.bookingId
        ? await db.collection("booking").findOne({
            _id:
              payment.bookingId instanceof ObjectId
                ? payment.bookingId
                : new ObjectId(payment.bookingId),
          })
        : null;

      // Stripe itself says the money arrived: settle the
      // booking here as well, so a delayed or missing webhook
      // can never leave a paid booking stuck in limbo.
      if (booking && session.payment_status === "paid") {
        const settlement = await settlePaidSession({
          db,
          booking,
          session,
        });

        if (
          settlement.outcome !== "already_settled" &&
          settlement.outcome !== "invalid_reference"
        ) {
          booking =
            await db.collection("booking").findOne({
              _id: booking._id,
            });
        }
      }

      return res.status(200).json({
        success: true,
        paymentStatus:
          session.payment_status === "paid"
            ? "paid"
            : session.status === "expired"
              ? "expired"
              : "pending",
        bookingStatus: booking?.status ?? null,
      });
    } catch (error) {
      console.error(
        "Session status error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to verify payment session",
      });
    }
  }
);

// ========================================
// GET /api/payments/history  (own payment records)
// ========================================
router.get("/history", verifyToken, async (req, res) => {
  try {
    const payments = await getDB()
      .collection("payment")
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      count: payments.length,
      data: payments.map((doc) => ({
        id: String(doc._id),
        bookingId: doc.bookingId
          ? String(doc.bookingId)
          : null,
        amount: doc.amount ?? null,
        currency: doc.currency ?? "usd",
        status: doc.status ?? "pending",
        createdAt: doc.createdAt ?? null,
      })),
    });
  } catch (error) {
    console.error(
      "Payment history error:",
      error?.message
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment history",
    });
  }
});

export default router;
