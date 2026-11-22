
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

import {
  verifyToken,
  verifyAdmin,
} from "../middleware/auth.middleware.js";

const router = Router();

const ALLOWED_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "removed",
];

// All routes require authenticated Admin access
router.use(verifyToken, verifyAdmin);

function isValidId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

// ========================================
// GET /api/admin/approvals/equipment
//
// Query: status = pending (default) | approved |
//         rejected | removed | all
// Preserves the original contract: without a status query
// the endpoint returns only pending listings.
// ========================================
router.get("/equipment", async (req, res) => {
  try {
    const { status = "pending" } = req.query;

    if (
      typeof status !== "string" ||
      (status !== "all" && !ALLOWED_STATUSES.includes(status))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid status filter",
      });
    }

    const filter =
      status === "all"
        ? { status: { $ne: "removed" } }
        : { status };

    const equipment = await getDB()
      .collection("equipment")
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      count: equipment.length,
      data: equipment,
    });
  } catch (error) {
    console.error("Load equipment error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to load equipment",
    });
  }
});

// ========================================
// GET /api/admin/approvals/equipment/:id
// Admin detail view for any listing.
// ========================================
router.get("/equipment/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const equipment = await getDB()
      .collection("equipment")
      .findOne({ _id: new ObjectId(id) });

    if (!equipment) {
      return res.status(404).json({
        success: false,
        message: "Equipment not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: equipment,
    });
  } catch (error) {
    console.error(
      "Equipment detail error:",
      error?.message
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});

// ========================================
// PATCH /api/admin/approvals/equipment/:id
//
// Body: { status: "approved" | "rejected",
//         reason?: string }   (reason used on rejection)
//
// Only a pending listing can be reviewed, so an item can
// never be approved twice. Every review is appended to
// reviewHistory for auditing.
// ========================================
router.patch("/equipment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body ?? {};

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid approval status",
      });
    }

    if (
      reason !== undefined &&
      reason !== null &&
      (typeof reason !== "string" ||
        reason.length > 500)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "reason must be a string of at most 500 characters",
      });
    }

    if (status === "rejected" && !String(reason ?? "").trim()) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason is required",
      });
    }

    const collection = getDB().collection("equipment");

    const now = new Date();
    const cleanReason =
      status === "rejected"
        ? String(reason).trim().slice(0, 500)
        : "";

    const result = await collection.updateOne(
      {
        _id: new ObjectId(id),
        status: "pending",
      },
      {
        $set: {
          status,
          reviewedBy: req.user.id,
          reviewedAt: now,
          rejectionReason:
            status === "rejected" ? cleanReason : "",
          updatedAt: now,
        },
        $push: {
          reviewHistory: {
            status,
            reviewedBy: req.user.id,
            reviewedAt: now,
            reason: cleanReason,
          },
        },
      }
    );

    if (result.matchedCount === 0) {
      const exists = await collection.findOne({
        _id: new ObjectId(id),
      });

      if (!exists) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      return res.status(409).json({
        success: false,
        message: `Equipment has already been ${exists.status}`,
      });
    }

    return res.status(200).json({
      success: true,
      message:
        status === "approved"
          ? "Equipment approved successfully"
          : "Equipment rejected successfully",
    });
  } catch (error) {
    console.error("Approval error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to review equipment",
    });
  }
});

export default router;
