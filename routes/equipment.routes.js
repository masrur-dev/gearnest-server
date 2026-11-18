
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const router = Router();

// GET ALL APPROVED EQUIPMENT
router.get("/", async (req, res) => {
  try {
    const collection = getDB().collection("equipment");

    const {
      search = "",
      category = "",
      rentalType = "",
      availability = "",
      sort = "newest",
      minPrice,
      maxPrice,
    } = req.query;

    const filter = { status: "approved" };

    // Search by equipment name or location
    if (typeof search === "string" && search.trim()) {
      const safeSearch = search
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.$or = [
        { name: { $regex: safeSearch, $options: "i" } },
        { location: { $regex: safeSearch, $options: "i" } },
      ];
    }

    // Category filter
    if (typeof category === "string" && category) {
      filter.category = category;
    }

    // Rental type filter
    if (
      typeof rentalType === "string" &&
      ["Daily", "Weekly", "Monthly"].includes(rentalType)
    ) {
      filter.rentalType = rentalType;
    }

    // Availability filter
    if (availability === "available") {
      filter.availableQuantity = { $gt: 0 };
    }

    if (availability === "unavailable") {
      filter.availableQuantity = { $lte: 0 };
    }

    // Price range filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      const min =
        minPrice === undefined ? 0 : Number(minPrice);

      const max =
        maxPrice === undefined ? Infinity : Number(maxPrice);

      if (
        !Number.isFinite(min) ||
        min < 0 ||
        Number.isNaN(max) ||
        max < min
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid price range",
        });
      }

      filter.rentalPrice = {
        $gte: min,
        ...(Number.isFinite(max) ? { $lte: max } : {}),
      };
    }

    // Sorting
    const sortOptions = {
      price_asc: { rentalPrice: 1 },
      price_desc: { rentalPrice: -1 },
      newest: { createdAt: -1 },
    };

    const sortBy =
      typeof sort === "string" && sortOptions[sort]
        ? sortOptions[sort]
        : sortOptions.newest;

    const equipment = await collection
      .find(filter)
      .sort(sortBy)
      .limit(50)
      .toArray();

    res.status(200).json({
      success: true,
      count: equipment.length,
      data: equipment,
    });
  } catch (error) {
    console.error("Equipment API Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});

// GET SINGLE APPROVED EQUIPMENT
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const equipment = await getDB()
      .collection("equipment")
      .findOne({
        _id: new ObjectId(id),
        status: "approved",
      });

    if (!equipment) {
      return res.status(404).json({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).json({
      success: true,
      data: equipment,
    });
  } catch (error) {
    console.error("Equipment Details Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});

export default router;
