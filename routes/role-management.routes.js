
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import {
  verifyToken,
  verifyAdmin,
} from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, verifyAdmin);

const allowedRoles = ["Customer", "Owner"];

function userFilter(id) {
  if (typeof id !== "string" || !id || id.length > 128) {
    return null;
  }

  if (ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id)) {
    return {
      $or: [
        { _id: new ObjectId(id) },
        { id },
      ],
    };
  }

  return { id };
}

// GET registered users for role management
router.get("/users", async (req, res) => {
  try {
    const users = await getDB()
      .collection("user")
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            role: 1,
          },
        }
      )
      .sort({ name: 1 })
      .toArray();

    return res.json({
      success: true,
      data: users.map((user) => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role ?? "Customer",
      })),
    });
  } catch (error) {
    console.error("Load users failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load users",
    });
  }
});

// PATCH Customer <-> Owner
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body ?? {};
    const filter = userFilter(req.params.id);

    if (!filter) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Only Customer and Owner roles are allowed",
      });
    }

    const collection = getDB().collection("user");
    const target = await collection.findOne(filter);

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Never modify Admin accounts here
    if (
      target.role === "Admin" ||
      String(target.id ?? target._id) === req.user.id
    ) {
      return res.status(403).json({
        success: false,
        message: "This account cannot be modified",
      });
    }

    if (
      target.role != null &&
      !allowedRoles.includes(target.role)
    ) {
      return res.status(403).json({
        success: false,
        message: "Unsupported current role",
      });
    }

    const roleCondition =
      target.role == null
        ? { role: null }
        : { role: target.role };

    const result = await collection.updateOne(
      {
        _id: target._id,
        ...roleCondition,
      },
      {
        $set: {
          role,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: "Account changed. Refresh and try again.",
      });
    }

    return res.json({
      success: true,
      message: `User role updated to ${role}`,
      data: {
        id: String(target._id),
        role,
      },
    });
  } catch (error) {
    console.error("Role update failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update user role",
    });
  }
});

export default router;
