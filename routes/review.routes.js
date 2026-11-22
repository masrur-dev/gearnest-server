
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import {
  verifyToken,
  verifyRenter,
} from "../middleware/auth.middleware.js";

const router = Router();

function isValidId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

function toPublicReview(doc) {
  return {
    id: String(doc._id),
    equipmentId: String(doc.equipmentId),
    userId: doc.userId ?? "",
    userName: doc.userName ?? "",
    rating: doc.rating,
    comment: doc.comment ?? "",
    createdAt: doc.createdAt ?? null,
  };
}

// ========================================
// GET /api/reviews/equipment/:equipmentId  (public)
// Only reviews for approved equipment are exposed.
// ========================================
router.get(
  "/equipment/:equipmentId",
  async (req, res) => {
    try {
      const { equipmentId } = req.params;

      if (!isValidId(equipmentId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const db = getDB();

      const equipment = await db
        .collection("equipment")
        .findOne({
          _id: new ObjectId(equipmentId),
          status: "approved",
        });

      if (!equipment) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      const reviews = await db
        .collection("review")
        .find({ equipmentId: equipment._id })
        .sort({ createdAt: -1 })
        .toArray();

      const total = reviews.length;
      const averageRating = total
        ? Number(
            (
              reviews.reduce((sum, r) => sum + r.rating, 0) /
              total
            ).toFixed(2)
          )
        : 0;

      return res.status(200).json({
        success: true,
        count: total,
        averageRating,
        data: reviews.map(toPublicReview),
      });
    } catch (error) {
      console.error("Reviews list error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch reviews",
      });
    }
  }
);

// ========================================
// POST /api/reviews  (Customer)
//
// Eligibility: the caller must own a booking for this
// equipment that has reached "completed".
// One review per booking.
// ========================================
router.post(
  "/",
  verifyToken,
  verifyRenter,
  async (req, res) => {
    try {
      const { equipmentId, bookingId, rating, comment } =
        req.body ?? {};

      if (
        !isValidId(equipmentId) ||
        !isValidId(bookingId)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment or booking ID",
        });
      }

      if (
        typeof rating !== "number" ||
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
      ) {
        return res.status(400).json({
          success: false,
          message: "rating must be an integer from 1 to 5",
        });
      }

      if (
        comment !== undefined &&
        comment !== null &&
        (typeof comment !== "string" ||
          comment.length > 1000)
      ) {
        return res.status(400).json({
          success: false,
          message: "comment must be a string of at most 1000 characters",
        });
      }

      const db = getDB();

      const booking = await db
        .collection("booking")
        .findOne({ _id: new ObjectId(bookingId) });

      if (
        !booking ||
        booking.customerId !== req.user.id ||
        String(booking.equipmentId) !== equipmentId
      ) {
        return res.status(403).json({
          success: false,
          message: "You can only review your own rentals",
        });
      }

      if (booking.status !== "completed") {
        return res.status(409).json({
          success: false,
          message:
            "Reviews are available after the rental is completed",
        });
      }

      const doc = {
        equipmentId: booking.equipmentId,
        bookingId: booking._id,
        userId: req.user.id,
        userName: req.user.name ?? "",
        rating,
        comment:
          typeof comment === "string"
            ? comment.trim().slice(0, 1000)
            : "",
        createdAt: new Date(),
      };

      try {
        const result = await db
          .collection("review")
          .insertOne(doc);

        return res.status(201).json({
          success: true,
          message: "Review submitted",
          data: toPublicReview({
            _id: result.insertedId,
            ...doc,
          }),
        });
      } catch (error) {
        // Unique index on bookingId + userId => one review per rental.
        if (error?.code === 11000) {
          return res.status(409).json({
            success: false,
            message: "You already reviewed this rental",
          });
        }

        throw error;
      }
    } catch (error) {
      console.error("Create review error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to submit review",
      });
    }
  }
);

// ========================================
// DELETE /api/reviews/:id  (own review or Admin)
// ========================================
router.delete(
  "/:id",
  verifyToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid review ID",
        });
      }

      const db = getDB();

      const filter = { _id: new ObjectId(id) };

      if (req.user.role !== "Admin") {
        filter.userId = req.user.id;
      }

      const result = await db
        .collection("review")
        .deleteOne(filter);

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Review not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Review deleted",
      });
    } catch (error) {
      console.error("Delete review error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to delete review",
      });
    }
  }
);

export default router;
