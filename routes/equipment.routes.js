
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const router = Router();

// ========================================
// GET ALL APPROVED EQUIPMENT
// Search, Filter, Sort
// ========================================

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
      page,
      limit,
    } = req.query;

    const filter = {
      status: "approved",
    };

    // Search by equipment name or location
    if (typeof search === "string" && search.trim()) {
      const safeSearch = search
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.$or = [
        {
          name: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          location: {
            $regex: safeSearch,
            $options: "i",
          },
        },
      ];
    }

    // Filter by category
    if (typeof category === "string" && category) {
      filter.category = category;
    }

    // Filter by rental type
    const allowedRentalTypes = [
      "Daily",
      "Weekly",
      "Monthly",
    ];

    if (
      typeof rentalType === "string" &&
      allowedRentalTypes.includes(rentalType)
    ) {
      filter.rentalType = rentalType;
    }

    // Filter by availability
    if (availability === "available") {
      filter.availableQuantity = {
        $gt: 0,
      };
    }

    if (availability === "unavailable") {
      filter.availableQuantity = {
        $lte: 0,
      };
    }

    // Filter by price range
    if (
      minPrice !== undefined ||
      maxPrice !== undefined
    ) {
      const min =
        minPrice === undefined
          ? 0
          : Number(minPrice);

      const max =
        maxPrice === undefined
          ? Infinity
          : Number(maxPrice);

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
        ...(Number.isFinite(max)
          ? { $lte: max }
          : {}),
      };
    }

    // Equipment sorting
    const sortOptions = {
      price_asc: {
        rentalPrice: 1,
      },
      price_desc: {
        rentalPrice: -1,
      },
      newest: {
        createdAt: -1,
      },
    };

    const sortBy =
      typeof sort === "string" && sortOptions[sort]
        ? sortOptions[sort]
        : sortOptions.newest;

    // Pagination (defaults keep the original 50 item cap)
    const pageNum = Math.max(
      1,
      Number.parseInt(page, 10) || 1
    );

    const limitNum = Math.min(
      50,
      Math.max(
        1,
        Number.parseInt(limit, 10) || 50
      )
    );

    const total = await collection.countDocuments(filter);

    // Fetch approved equipment
    const equipment = await collection
      .find(filter)
      .sort(sortBy)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .toArray();

    return res.status(200).json({
      success: true,
      count: equipment.length,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      data: equipment,
    });
  } catch (error) {
    console.error("Equipment API Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});

// ========================================
// GET SINGLE APPROVED EQUIPMENT
// ========================================

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate MongoDB ObjectId
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

    return res.status(200).json({
      success: true,
      data: equipment,
    });
  } catch (error) {
    console.error(
      "Equipment Details API Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch equipment details",
    });
  }
});

export default router;
