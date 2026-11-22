
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

import {
  verifyToken,
  verifyOwner,
} from "../middleware/auth.middleware.js";

const router = Router();

const categories = [
  "Construction",
  "Photography",
  "Transportation",
  "Agriculture",
  "Electronics",
  "Events",
];

const rentalTypes = ["Daily", "Weekly", "Monthly"];

const conditions = ["New", "Excellent", "Good", "Fair"];

function isValidId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

function validateImageUrl(image) {
  try {
    const parsed = new URL(image);

    if (
      !["https:", "http:"].includes(parsed.protocol)
    ) {
      throw new Error("Invalid protocol");
    }

    return parsed.href;
  } catch {
    return null;
  }
}

// Shared validation for create and update.
function validateEquipmentBody(body) {
  const {
    name,
    description,
    category,
    location,
    rentalPrice,
    rentalType,
    availableQuantity,
    condition,
    brand,
    model,
    image,
    rentalTerms,
  } = body ?? {};

  const textFields = {
    name,
    description,
    location,
    brand,
    model,
    rentalTerms,
  };

  for (const [field, value] of Object.entries(textFields)) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 2000
    ) {
      return {
        error: `Invalid or missing ${field}`,
      };
    }
  }

  if (
    !categories.includes(category) ||
    !rentalTypes.includes(rentalType) ||
    !conditions.includes(condition)
  ) {
    return {
      error:
        "Invalid equipment category, type, or condition",
    };
  }

  if (
    typeof rentalPrice !== "number" ||
    !Number.isFinite(rentalPrice) ||
    rentalPrice <= 0 ||
    typeof availableQuantity !== "number" ||
    !Number.isInteger(availableQuantity) ||
    availableQuantity < 1
  ) {
    return {
      error: "Invalid price or quantity",
    };
  }

  const imageURL = validateImageUrl(image);

  if (!imageURL) {
    return {
      error: "A valid equipment image URL is required",
    };
  }

  return {
    value: {
      name: name.trim(),
      description: description.trim(),
      category,
      location: location.trim(),
      rentalPrice,
      rentalType,
      availableQuantity,
      condition,
      brand: brand.trim(),
      model: model.trim(),
      image: imageURL,
      rentalTerms: rentalTerms.trim(),
    },
  };
}

// ========================================
// Owner Equipment API contract
//
// POST   /api/owner/equipment            create (always pending)
// GET    /api/owner/equipment            list own, any status
// GET    /api/owner/equipment/:id        read one (owner only)
// PATCH  /api/owner/equipment/:id        edit (owner only)
// DELETE /api/owner/equipment/:id        archive (owner only)
//
// Server controlled on create:
//   status            always "pending"
//   ownerId/ownerName/ownerEmail   from the verified JWT
//   createdAt/updatedAt           set by the server
//
// Editing an approved listing resets it to "pending" so an
// admin re-reviews the changed content.
//
// DELETE is a soft delete (status "removed") so booking and
// payment history stays intact. Listings with an active or
// unpaid rental cannot be removed.
// ========================================

// Owner: Add Equipment
router.post(
  "/equipment",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const check = validateEquipmentBody(req.body);

      if (check.error) {
        return res.status(400).json({
          success: false,
          message: check.error,
        });
      }

      const equipment = {
        ...check.value,

        // Never accept these from the client
        ownerId: req.user.id,
        ownerName: req.user.name,
        ownerEmail: req.user.email,
        status: "pending",

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await getDB()
        .collection("equipment")
        .insertOne(equipment);

      return res.status(201).json({
        success: true,
        message: "Equipment submitted for admin approval",
        insertedId: result.insertedId,
        data: {
          _id: result.insertedId,
          ...equipment,
        },
      });
    } catch (error) {
      console.error("Add Equipment Error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to add equipment",
      });
    }
  }
);

// Owner: My Equipment
router.get(
  "/equipment",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const equipment = await getDB()
        .collection("equipment")
        .find({
          ownerId: req.user.id,
          status: { $ne: "removed" },
        })
        .sort({ createdAt: -1 })
        .toArray();

      return res.status(200).json({
        success: true,
        count: equipment.length,
        data: equipment,
      });
    } catch (error) {
      console.error("My Equipment Error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch owner equipment",
      });
    }
  }
);

// Owner: single listing (ownership enforced)
router.get(
  "/equipment/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
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
        .findOne({
          _id: new ObjectId(id),
          ownerId: req.user.id,
          status: { $ne: "removed" },
        });

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
  }
);

// Owner: edit listing (ownership enforced)
router.patch(
  "/equipment/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const db = getDB();

      const existing = await db
        .collection("equipment")
        .findOne({
          _id: new ObjectId(id),
          ownerId: req.user.id,
          status: { $ne: "removed" },
        });

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      // Merge with the stored document so partial bodies work.
      const check = validateEquipmentBody({
        ...existing,
        ...req.body,
        // Never overridable by the client:
        ownerId: existing.ownerId,
        ownerName: existing.ownerName,
        ownerEmail: existing.ownerEmail,
        status: existing.status,
      });

      if (check.error) {
        return res.status(400).json({
          success: false,
          message: check.error,
        });
      }

      const updates = {
        ...check.value,
        updatedAt: new Date(),
      };

      // Policy: editing content on an approved listing sends it
      // back to the admin queue for re-review.
      if (existing.status === "approved") {
        updates.status = "pending";
        updates.reapprovalRequestedAt = new Date();
      }

      await db.collection("equipment").updateOne(
        { _id: existing._id, ownerId: req.user.id },
        { $set: updates }
      );

      const updated = await db
        .collection("equipment")
        .findOne({ _id: existing._id });

      return res.status(200).json({
        success: true,
        message:
          existing.status === "approved"
            ? "Equipment updated and submitted for re-approval"
            : "Equipment updated",
        data: updated,
      });
    } catch (error) {
      console.error(
        "Equipment update error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to update equipment",
      });
    }
  }
);

// Owner: archive listing (ownership enforced)
router.delete(
  "/equipment/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const db = getDB();

      const existing = await db
        .collection("equipment")
        .findOne({
          _id: new ObjectId(id),
          ownerId: req.user.id,
          status: { $ne: "removed" },
        });

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      // Keep history: refuse to remove items with live rentals.
      const liveBookings = await db
        .collection("booking")
        .countDocuments({
          equipmentId: existing._id,
          status: {
            $in: [
              "pending_payment",
              "confirmed",
              "active",
            ],
          },
        });

      if (liveBookings > 0) {
        return res.status(409).json({
          success: false,
          message:
            "This equipment has active rentals and cannot be removed",
        });
      }

      // Soft delete keeps booking and payment history intact.
      await db.collection("equipment").updateOne(
        { _id: existing._id, ownerId: req.user.id },
        {
          $set: {
            status: "removed",
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      return res.status(200).json({
        success: true,
        message: "Equipment removed",
      });
    } catch (error) {
      console.error(
        "Equipment delete error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to remove equipment",
      });
    }
  }
);

export default router;
