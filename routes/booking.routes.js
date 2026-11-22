
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB, client } from "../config/db.js";

import {
  verifyToken,
  verifyRenter,
  verifyOwner,
} from "../middleware/auth.middleware.js";

import {
  calculateRentalCost,
  OCCUPYING_STATUSES,
  CUSTOMER_CANCELLABLE,
  BOOKING_STATUSES,
} from "../config/pricing.js";

import {
  releaseStaleBookings,
  advanceBookingStatuses,
} from "../config/booking-lifecycle.js";

import { handleCancelledBooking } from "../services/stripe-services.js";

const router = Router();

function isValidId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

export function toPublicBooking(doc) {
  if (!doc) return null;

  return {
    id: String(doc._id),
    equipmentId: String(doc.equipmentId),
    equipmentName: doc.equipmentName ?? "",
    equipmentImage: doc.equipmentImage ?? "",
    ownerId: doc.ownerId ?? "",
    ownerName: doc.ownerName ?? "",
    customerId: doc.customerId ?? "",
    customerName: doc.customerName ?? "",
    customerEmail: doc.customerEmail ?? "",
    quantity: doc.quantity,
    rentalType: doc.rentalType,
    startDate: doc.startDate,
    endDate: doc.endDate,
    days: doc.days,
    units: doc.units,
    unitPrice: doc.unitPrice,
    totalAmount: doc.totalAmount,
    currency: doc.currency ?? "usd",
    status: doc.status,
    paymentStatus: doc.paymentStatus ?? null,
    paidAt: doc.paidAt ?? null,
    stripeSessionId: doc.stripeSessionId ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

// Sum of quantities already booked for the overlapping dates.
async function overlappingQuantity(db, {
  equipmentId,
  startDate,
  endDate,
  excludeBookingId = null,
  session = null,
}) {
  const match = {
    equipmentId,
    status: { $in: OCCUPYING_STATUSES },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };

  if (excludeBookingId) {
    match._id = { $ne: excludeBookingId };
  }

  const rows = await db
    .collection("booking")
    .aggregate(
      [
        { $match: match },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ],
      session ? { session } : {}
    )
    .toArray();

  return rows[0]?.qty ?? 0;
}

// ========================================
// POST /api/bookings  (Customer)
//
// The price is ALWAYS calculated on the server from the stored
// equipment document. The client only sends equipmentId,
// quantity and the date range.
// ========================================
router.post(
  "/",
  verifyToken,
  verifyRenter,
  async (req, res) => {
    try {
      const { equipmentId, quantity, startDate, endDate } =
        req.body ?? {};

      if (!isValidId(equipmentId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const db = getDB();

      // Release expired holds before checking availability.
      await releaseStaleBookings(db);

      const equipment = await db
        .collection("equipment")
        .findOne({ _id: new ObjectId(equipmentId) });

      if (
        !equipment ||
        equipment.status !== "approved"
      ) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      const cost = calculateRentalCost({
        rentalPrice: equipment.rentalPrice,
        rentalType: equipment.rentalType,
        startDate,
        endDate,
        quantity,
      });

      if (cost.error) {
        return res.status(400).json({
          success: false,
          message: cost.error,
        });
      }

      const booking = cost.value;

      if (
        typeof equipment.availableQuantity !== "number" ||
        equipment.availableQuantity < booking.quantity
      ) {
        return res.status(409).json({
          success: false,
          message: "Not enough units available",
        });
      }

      // Fast pre-check: are these dates already full?
      const usedBefore = await overlappingQuantity(db, {
        equipmentId: equipment._id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      });

      if (
        usedBefore + booking.quantity >
        equipment.availableQuantity
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Equipment is not available for the selected dates",
        });
      }

      // Availability check + insert run inside one transaction.
      // The first statement writes the equipment document, so
      // two concurrent bookings for the same item conflict and
      // the driver retries: the overlap check can never race.
      const session = client.startSession();

      let created = null;
      let conflict = false;
      let notFound = false;

      try {
        await session.withTransaction(async () => {
          const now = new Date();

          const touch = await db
            .collection("equipment")
            .updateOne(
              {
                _id: equipment._id,
                status: "approved",
              },
              { $set: { lastBookedAt: now } },
              { session }
            );

          if (touch.matchedCount === 0) {
            notFound = true;
            return;
          }

          const fresh = await db
            .collection("equipment")
            .findOne(
              { _id: equipment._id, status: "approved" },
              { session }
            );

          if (!fresh) {
            notFound = true;
            return;
          }

          if (
            typeof fresh.availableQuantity !== "number" ||
            fresh.availableQuantity < booking.quantity
          ) {
            conflict = true;
            return;
          }

          const used = await overlappingQuantity(db, {
            equipmentId: fresh._id,
            startDate: booking.startDate,
            endDate: booking.endDate,
            session,
          });

          if (used + booking.quantity > fresh.availableQuantity) {
            conflict = true;
            return;
          }

          const doc = {
            equipmentId: fresh._id,
            equipmentName: fresh.name,
            equipmentImage: fresh.image ?? "",
            ownerId: fresh.ownerId ?? "",
            ownerName: fresh.ownerName ?? "",
            ownerEmail: fresh.ownerEmail ?? "",
            customerId: req.user.id,
            customerName: req.user.name ?? "",
            customerEmail: req.user.email ?? "",
            quantity: booking.quantity,
            rentalType: fresh.rentalType,
            startDate: booking.startDate,
            endDate: booking.endDate,
            days: booking.days,
            units: booking.units,
            unitPrice: booking.unitPrice,
            totalAmount: booking.totalAmount,
            currency: booking.currency,
            status: "pending_payment",
            stripeSessionId: null,
            createdAt: now,
            updatedAt: now,
          };

          const result = await db
            .collection("booking")
            .insertOne(doc, { session });

          created = {
            _id: result.insertedId,
            ...doc,
          };
        });
      } finally {
        await session.endSession();
      }

      if (notFound) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      if (conflict || !created) {
        return res.status(409).json({
          success: false,
          message:
            "Equipment is not available for the selected dates",
        });
      }

      return res.status(201).json({
        success: true,
        message: "Booking created. Complete payment to confirm.",
        data: toPublicBooking(created),
      });
    } catch (error) {
      console.error("Create booking error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to create booking",
      });
    }
  }
);

// ========================================
// GET /api/bookings  (any authenticated user)
// Returns only the caller's own bookings.
// ========================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    await releaseStaleBookings(db);
    await advanceBookingStatuses(db);

    // Optional status filter (e.g. active rentals vs past rentals).
    const { status } = req.query;

    const filter = { customerId: req.user.id };

    if (status !== undefined) {
      if (
        typeof status !== "string" ||
        !BOOKING_STATUSES.includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter",
        });
      }

      filter.status = status;
    }

    const bookings = await db
      .collection("booking")
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings.map(toPublicBooking),
    });
  } catch (error) {
    console.error("List bookings error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
});

// ========================================
// GET /api/bookings/owner/requests  (Owner)
// Rental requests for the caller's own equipment.
// Registered before /:id so it is not captured as an ID.
// ========================================
router.get(
  "/owner/requests",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const db = getDB();

      await releaseStaleBookings(db);
      await advanceBookingStatuses(db);

      const { status = "" } = req.query;

      const filter = { ownerId: req.user.id };

      if (typeof status === "string" && status) {
        if (!BOOKING_STATUSES.includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status filter",
          });
        }

        filter.status = status;
      }

      const bookings = await db
        .collection("booking")
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      return res.status(200).json({
        success: true,
        count: bookings.length,
        data: bookings.map(toPublicBooking),
      });
    } catch (error) {
      console.error(
        "Owner requests error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch rental requests",
      });
    }
  }
);

// ========================================
// GET /api/bookings/:id
// Customer, owner of the equipment, or Admin.
// ========================================
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID",
      });
    }

    const db = getDB();

    await releaseStaleBookings(db);
    await advanceBookingStatuses(db);

    const booking = await db
      .collection("booking")
      .findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const isCustomer =
      booking.customerId === req.user.id;
    const isOwner = booking.ownerId === req.user.id;
    const isAdmin = req.user.role === "Admin";

    if (!isCustomer && !isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You cannot view this booking",
      });
    }

    return res.status(200).json({
      success: true,
      data: toPublicBooking(booking),
    });
  } catch (error) {
    console.error("Booking detail error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch booking",
    });
  }
});

// ========================================
// POST /api/bookings/:id/cancel  (Customer)
// Only the customer who created the booking may cancel,
// and only while it is pending payment or confirmed.
// ========================================
router.post(
  "/:id/cancel",
  verifyToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid booking ID",
        });
      }

      const db = getDB();
      const booking = await db
        .collection("booking")
        .findOne({ _id: new ObjectId(id) });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: "Booking not found",
        });
      }

      const isAdmin = req.user.role === "Admin";

      if (booking.customerId !== req.user.id && !isAdmin) {
        return res.status(403).json({
          success: false,
          message: "You cannot cancel this booking",
        });
      }

      if (
        !CUSTOMER_CANCELLABLE.includes(booking.status)
      ) {
        return res.status(409).json({
          success: false,
          message: `A ${booking.status} booking cannot be cancelled`,
        });
      }

      const result = await db
        .collection("booking")
        .updateOne(
          {
            _id: booking._id,
            status: { $in: CUSTOMER_CANCELLABLE },
          },
          {
            $set: {
              status: "cancelled",
              updatedAt: new Date(),
            },
          }
        );

      if (result.matchedCount === 0) {
        return res.status(409).json({
          success: false,
          message: "Booking can no longer be cancelled",
        });
      }

      // Paid: refund it. Open session: retire it so payment
      // history does not stay pending forever.
      const settlement = await handleCancelledBooking({
        db,
        booking,
        context: "cancel",
      });

      return res.status(200).json({
        success: true,
        refunded: settlement.refunded,
        message: settlement.refunded
          ? "Booking cancelled and refunded"
          : "Booking cancelled",
      });
    } catch (error) {
      console.error("Cancel booking error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to cancel booking",
      });
    }
  }
);

// ========================================
// POST /api/bookings/:id/decline  (Owner)
// The equipment owner may decline a request for their item.
// ========================================
router.post(
  "/:id/decline",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid booking ID",
        });
      }

      const db = getDB();

      const booking = await db
        .collection("booking")
        .findOne({ _id: new ObjectId(id) });

      const declined = () =>
        res.status(404).json({
          success: false,
          message:
            "Booking not found or cannot be declined",
        });

      if (
        !booking ||
        booking.ownerId !== req.user.id ||
        !CUSTOMER_CANCELLABLE.includes(booking.status)
      ) {
        return declined();
      }

      const result = await db
        .collection("booking")
        .updateOne(
          {
            _id: booking._id,
            ownerId: req.user.id,
            status: { $in: CUSTOMER_CANCELLABLE },
          },
          {
            $set: {
              status: "cancelled",
              updatedAt: new Date(),
            },
          }
        );

      if (result.matchedCount === 0) {
        return declined();
      }

      // A paid request must be refunded when the owner
      // rejects it.
      const settlement = await handleCancelledBooking({
        db,
        booking,
        context: "decline",
      });

      return res.status(200).json({
        success: true,
        refunded: settlement.refunded,
        message: settlement.refunded
          ? "Booking declined and refunded"
          : "Booking declined",
      });
    } catch (error) {
      console.error("Decline booking error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to decline booking",
      });
    }
  }
);

// ========================================
// POST /api/bookings/:id/complete  (Owner)
// The owner hands the equipment back and closes the rental.
// ========================================
router.post(
  "/:id/complete",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid booking ID",
        });
      }

      const db = getDB();

      const result = await db
        .collection("booking")
        .updateOne(
          {
            _id: new ObjectId(id),
            ownerId: req.user.id,
            status: { $in: ["confirmed", "active"] },
          },
          {
            $set: {
              status: "completed",
              updatedAt: new Date(),
            },
          }
        );

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message:
            "Booking not found or cannot be completed",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Booking completed",
      });
    } catch (error) {
      console.error(
        "Complete booking error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to complete booking",
      });
    }
  }
);

export default router;
