
import { Router } from "express";
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

const conditions = [
  "New",
  "Excellent",
  "Good",
  "Fair",
];

// Owner: Add Equipment
router.post(
  "/equipment",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
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
      } = req.body ?? {};

      // Required text fields
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
          return res.status(400).json({
            success: false,
            message: `Invalid or missing ${field}`,
          });
        }
      }

      // Validate dropdowns
      if (
        !categories.includes(category) ||
        !rentalTypes.includes(rentalType) ||
        !conditions.includes(condition)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment category, type, or condition",
        });
      }

      // Validate numeric fields
      if (
        typeof rentalPrice !== "number" ||
        !Number.isFinite(rentalPrice) ||
        rentalPrice <= 0 ||
        typeof availableQuantity !== "number" ||
        !Number.isInteger(availableQuantity) ||
        availableQuantity < 1
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid price or quantity",
        });
      }

      // Validate image URL
      let imageURL;

      try {
        const parsed = new URL(image);

        if (!["https:", "http:"].includes(parsed.protocol)) {
          throw new Error("Invalid protocol");
        }

        imageURL = parsed.href;
      } catch {
        return res.status(400).json({
          success: false,
          message: "A valid equipment image URL is required",
        });
      }

      const equipment = {
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
      });
    } catch (error) {
      console.error("Add Equipment Error:", error);

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
        .find({ ownerId: req.user.id })
        .sort({ createdAt: -1 })
        .toArray();

      return res.status(200).json({
        success: true,
        count: equipment.length,
        data: equipment,
      });
    } catch (error) {
      console.error("My Equipment Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch owner equipment",
      });
    }
  }
);

export default router;
