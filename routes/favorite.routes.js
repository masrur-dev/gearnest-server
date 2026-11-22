
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

function isValidId(value) {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value)
  );
}

// ========================================
// GET /api/favorites  (own list, joined with equipment)
// ========================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    const favorites = await db
      .collection("favorite")
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    const equipmentIds = favorites
      .map((f) => f.equipmentId)
      .filter((id) => id instanceof ObjectId);

    const equipment = equipmentIds.length
      ? await db
          .collection("equipment")
          .find({ _id: { $in: equipmentIds } })
          .toArray()
      : [];

    const byId = new Map(
      equipment.map((item) => [String(item._id), item])
    );

    return res.status(200).json({
      success: true,
      count: favorites.length,
      data: favorites.map((fav) => ({
        id: String(fav._id),
        equipmentId: String(fav.equipmentId),
        createdAt: fav.createdAt ?? null,
        equipment: byId.get(String(fav.equipmentId)) ?? null,
      })),
    });
  } catch (error) {
    console.error("Favorites list error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch favorites",
    });
  }
});

// ========================================
// POST /api/favorites/:equipmentId
// ========================================
router.post(
  "/:equipmentId",
  verifyToken,
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

      await db.collection("favorite").updateOne(
        {
          userId: req.user.id,
          equipmentId: equipment._id,
        },
        {
          $setOnInsert: {
            userId: req.user.id,
            equipmentId: equipment._id,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );

      return res.status(201).json({
        success: true,
        message: "Added to favorites",
      });
    } catch (error) {
      console.error("Add favorite error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to add favorite",
      });
    }
  }
);

// ========================================
// DELETE /api/favorites/:equipmentId
// ========================================
router.delete(
  "/:equipmentId",
  verifyToken,
  async (req, res) => {
    try {
      const { equipmentId } = req.params;

      if (!isValidId(equipmentId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const result = await getDB()
        .collection("favorite")
        .deleteOne({
          userId: req.user.id,
          equipmentId: new ObjectId(equipmentId),
        });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Favorite not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Removed from favorites",
      });
    } catch (error) {
      console.error(
        "Remove favorite error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to remove favorite",
      });
    }
  }
);

export default router;
