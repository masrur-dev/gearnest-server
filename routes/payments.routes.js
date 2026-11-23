
import { Router, raw } from "express";
import { ObjectId } from "mongodb";

import {
  getStripe,
  amountInCents,
  settlePaidSession,
  retireOpenCheckoutSession,
} from "../services/stripe-services.js";

const COLLECTION = "booking";
const PAYMENT_TTL_MS = 30 * 60 * 1000;

function validId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

function bookingExpired(booking) {
  const created = new Date(booking.createdAt).getTime();

  return (
    !Number.isFinite(created) ||
    Date.now() - created >= PAYMENT_TTL_MS
  );
}

// ====================================
// CREATE STRIPE CHECKOUT SESSION
// POST /api/payments/create-checkout-session
// ====================================

export function createPaymentRouter({
  db,
  verifyToken,
}) {
  const router = Router();
  const bookings = db.collection(COLLECTION);
  const payments = db.collection("payment");

  router.post(
    "/create-checkout-session",
    verifyToken,
    async (req, res) => {
      try {
        const stripe = getStripe();

        if (!stripe) {
          return res.status(503).json({
            success: false,
            message: "Payments are not configured",
          });
        }

        const { bookingId } = req.body ?? {};

        if (!validId(bookingId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid booking ID",
          });
        }

        const booking = await bookings.findOne({
          _id: new ObjectId(bookingId),
        });

        if (!booking) {
          return res.status(404).json({
            success: false,
            message: "Booking not found",
          });
        }

        if (
          String(booking.customerId) !==
          String(req.user?.id)
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied",
          });
        }

        if (booking.status !== "pending_payment") {
          return res.status(409).json({
            success: false,
            message: "Booking is not payable",
          });
        }

        if (booking.paymentStatus === "paid") {
          return res.status(409).json({
            success: false,
            message: "Booking already paid",
          });
        }

        if (bookingExpired(booking)) {
          await bookings.updateOne(
            {
              _id: booking._id,
              status: "pending_payment",
            },
            {
              $set: {
                status: "expired",
                updatedAt: new Date(),
              },
            }
          );

          return res.status(409).json({
            success: false,
            message: "Booking expired",
          });
        }

        const amount = amountInCents(booking);

        if (!amount) {
          return res.status(400).json({
            success: false,
            message: "Invalid rental amount",
          });
        }

        const clientUrl = process.env.CLIENT_URL;

        if (!clientUrl) {
          throw new Error("CLIENT_URL is missing");
        }

        // Reuse an existing open Checkout Session.
        if (booking.stripeSessionId) {
          try {
            const existing =
              await stripe.checkout.sessions.retrieve(
                booking.stripeSessionId
              );

            if (existing.status === "complete") {
              // The session already ran: never start a
              // second charge for the same booking.
              return res.status(409).json({
                success: false,
                message:
                  existing.payment_status === "paid"
                    ? "Booking already paid"
                    : "Payment already completed",
              });
            }

            if (
              existing.status === "open" &&
              existing.url &&
              existing.amount_total === amount &&
              existing.currency === "usd"
            ) {
              return res.json({
                success: true,
                bookingId,
                url: existing.url,
              });
            }

            // Never create a replacement while the old session
            // might still accept payment.
            if (existing.status === "open") {
              let retirement;

              try {
                retirement =
                  await retireOpenCheckoutSession(
                    stripe,
                    existing.id
                  );
              } catch (error) {
                console.error(
                  "Checkout session retirement failed:",
                  error?.message
                );

                return res.status(503).json({
                  success: false,
                  message:
                    "Could not safely replace the existing checkout session. Please retry.",
                });
              }

              if (retirement === "complete") {
                return res.status(409).json({
                  success: false,
                  message:
                    "Payment session was already completed. Check payment status before retrying.",
                });
              }
            }
          } catch (error) {
            console.error(
              "Existing checkout session could not be verified:",
              error?.message
            );

            return res.status(503).json({
              success: false,
              message:
                "Could not verify the existing checkout session. Please retry.",
            });
          }
        }

        // Stripe chooses enabled compatible payment methods.
        const session =
          await stripe.checkout.sessions.create({
            mode: "payment",
            client_reference_id: bookingId,

            line_items: [
              {
                price_data: {
                  currency: "usd",
                  unit_amount: amount,
                  product_data: {
                    name:
                      booking.equipmentName ||
                      "GearNest Equipment Rental",
                  },
                },
                quantity: 1,
              },
            ],

            metadata: {
              bookingId,
            },

            success_url:
              `${clientUrl}` +
              `${process.env.PAYMENT_SUCCESS_PATH || "/payment/success"}` +
              "?session_id={CHECKOUT_SESSION_ID}",

            cancel_url:
              `${clientUrl}` +
              `${process.env.PAYMENT_CANCEL_PATH || "/payment/cancel"}`,
          });

        const result = await bookings.updateOne(
          {
            _id: booking._id,
            customerId: req.user.id,
            status: "pending_payment",
            paymentStatus: { $ne: "paid" },
            stripeSessionId:
              booking.stripeSessionId ?? null,
          },
          {
            $set: {
              stripeSessionId: session.id,
              paymentStatus: "pending",
              updatedAt: new Date(),
            },
          }
        );

        if (result.matchedCount === 0) {
          try {
            const retirement =
              await retireOpenCheckoutSession(
                stripe,
                session.id
              );

            if (retirement !== "expired") {
              return res.status(503).json({
                success: false,
                message:
                  "Booking changed while payment completed. Check payment status before retrying.",
              });
            }
          } catch (error) {
            console.error(
              "Unattached checkout session retirement failed:",
              error?.message
            );

            return res.status(503).json({
              success: false,
              message:
                "Booking changed and the checkout session could not be safely retired.",
            });
          }

          return res.status(409).json({
            success: false,
            message: "Booking changed. Retry payment.",
          });
        }

        // Track the payment so dashboards and payment history
        // see it. Upsert: retrying checkout reuses the record.
        await payments.updateOne(
          { stripeSessionId: session.id },
          {
            $setOnInsert: {
              bookingId: booking._id,
              userId: req.user.id,
              amount: Number(booking.totalAmount),
              currency: "usd",
              stripePaymentIntentId:
                session.payment_intent ?? null,
              status: "pending",
              createdAt: new Date(),
            },
            $set: { updatedAt: new Date() },
          },
          { upsert: true }
        );

        return res.status(200).json({
          success: true,
          bookingId,
          url: session.url,
        });
      } catch (error) {
        console.error("Stripe Checkout Error:", {
          message: error.message,
          type: error.type,
          code: error.code,
          param: error.param,
          statusCode: error.statusCode,
        });

        return res.status(500).json({
          success: false,
          message: "Unable to create checkout",
        });
      }
    }
  );

  return router;
}

// ====================================
// STRIPE WEBHOOK
// POST /api/payments/webhook
// ====================================

export function createPaymentWebhookRouter({ db }) {
  const router = Router();
  const bookings = db.collection(COLLECTION);
  const payments = db.collection("payment");

  router.post(
    "/",
    raw({ type: "application/json" }),
    async (req, res) => {
      const stripe = getStripe();
      const signature =
        req.headers["stripe-signature"];

      const secret =
        process.env.STRIPE_WEBHOOK_SECRET;

      if (!stripe || !secret) {
        return res.status(503).send(
          "Stripe webhook is not configured"
        );
      }

      if (
        typeof signature !== "string" ||
        !Buffer.isBuffer(req.body)
      ) {
        return res.status(400).send(
          "Invalid webhook request"
        );
      }

      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          secret
        );
      } catch (error) {
        console.error(
          "Webhook signature error:",
          error.message
        );

        return res.status(400).send(
          "Invalid webhook signature"
        );
      }

      const allowedEvents = [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
        "charge.refunded",
      ];

      if (!allowedEvents.includes(event.type)) {
        return res.json({ received: true });
      }

      // Idempotency: the first delivery of an event id wins.
      // Redeliveries are acknowledged without side effects.
      const seen = await payments.updateOne(
        { stripeEventId: event.id },
        {
          $setOnInsert: {
            stripeEventId: event.id,
            eventType: event.type,
            status: "processing",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );

      if (seen.upsertedCount === 0) {
        return res.json({
          received: true,
          duplicate: true,
        });
      }

      try {
        const session = event.data.object;
        const now = new Date();

        // Settlement decision, reported back for testability
        // and for anyone inspecting Stripe's delivery log.
        let outcome = null;

        // A failure answer must release the idempotency marker,
        // otherwise Stripe's retry would be flagged a duplicate
        // and the event could never be processed.
        const reject = async (status, message) => {
          await payments
            .deleteOne({ stripeEventId: event.id })
            .catch(() => {});

          return res.status(status).json({
            received: false,
            message,
          });
        };

        // Refunds carry a Charge, not a Checkout Session.
        if (event.type === "charge.refunded") {
          const payment = session.payment_intent
            ? await payments.findOne({
                stripePaymentIntentId:
                  session.payment_intent,
              })
            : null;

          let bookingId = payment?.bookingId ?? null;

          if (payment) {
            await payments.updateOne(
              { _id: payment._id },
              {
                $set: {
                  status: "refunded",
                  refundedAt: now,
                  updatedAt: now,
                },
              }
            );
          }

          if (!bookingId && session.payment_intent) {
            const linked = await bookings.findOne({
              stripePaymentIntentId:
                session.payment_intent,
            });

            bookingId = linked?._id ?? null;
          }

          if (bookingId) {
            await bookings.updateOne(
              { _id: bookingId },
              {
                $set: {
                  paymentStatus: "refunded",
                  updatedAt: now,
                },
              }
            );

            await bookings.updateOne(
              {
                _id: bookingId,
                status: {
                  $in: [
                    "confirmed",
                    "active",
                    "completed",
                  ],
                },
              },
              {
                $set: {
                  status: "refunded",
                  updatedAt: now,
                },
              }
            );
          }

          outcome = "refund_recorded";
        } else {
          const bookingId = session.metadata?.bookingId;

          if (
            !validId(bookingId) ||
            session.client_reference_id !== bookingId ||
            session.mode !== "payment"
          ) {
            return await reject(
              400,
              "Invalid booking reference"
            );
          }

          const booking = await bookings.findOne({
            _id: new ObjectId(bookingId),
          });

          if (!booking) {
            return await reject(
              500,
              "Booking not found"
            );
          }

          const successful =
            event.type ===
              "checkout.session.completed" ||
            event.type ===
              "checkout.session.async_payment_succeeded";

          if (successful) {
            // One decision point for money that arrived:
            // confirm, ignore duplicates, or refund what no
            // longer belongs (duplicate / late sessions).
            const settlement = await settlePaidSession({
              db,
              booking,
              session,
            });

            outcome = settlement.outcome;

            console.log(
              "Webhook settlement:",
              bookingId,
              settlement.outcome
            );
          } else {
            // Failed / expired events keep the strict
            // verification: nothing to refund here, so a
            // mismatching session must not touch the booking.
            if (
              booking.stripeSessionId !== session.id ||
              session.amount_total !==
                amountInCents(booking) ||
              session.currency !== "usd"
            ) {
              return await reject(
                400,
                "Payment verification failed"
              );
            }

            outcome = event.type;

            if (
              event.type ===
              "checkout.session.async_payment_failed"
            ) {
              await bookings.updateOne(
                {
                  _id: booking._id,
                  status: "pending_payment",
                  stripeSessionId: session.id,
                  paymentStatus: { $ne: "paid" },
                },
                {
                  $set: {
                    paymentStatus: "failed",
                    updatedAt: now,
                  },
                }
              );

              await payments.updateOne(
                {
                  stripeSessionId: session.id,
                  status: { $ne: "paid" },
                },
                {
                  $set: {
                    status: "failed",
                    updatedAt: now,
                  },
                }
              );
            }

            if (
              event.type === "checkout.session.expired"
            ) {
              await bookings.updateOne(
                {
                  _id: booking._id,
                  status: "pending_payment",
                  stripeSessionId: session.id,
                },
                {
                  $set: {
                    status: "expired",
                    updatedAt: now,
                  },
                }
              );

              await payments.updateOne(
                {
                  stripeSessionId: session.id,
                  status: { $ne: "paid" },
                },
                {
                  $set: {
                    status: "expired",
                    updatedAt: now,
                  },
                }
              );
            }
          }
        }

        // Event fully handled: record the outcome.
        await payments.updateOne(
          { stripeEventId: event.id },
          {
            $set: {
              status: "processed",
              updatedAt: new Date(),
            },
          }
        );

        return res.json({
          received: true,
          outcome,
        });
      } catch (error) {
        console.error(
          "Webhook processing error:",
          error
        );

        // Let the idempotency marker be retried: without this,
        // a transient failure would permanently skip the event.
        await payments
          .deleteOne({ stripeEventId: event.id })
          .catch(() => {});

        return res.status(500).json({
          received: false,
        });
      }
    }
  );

  return router;
}
