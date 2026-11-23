
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import {
  verifyToken,
  verifyAdmin,
} from "../middleware/auth.middleware.js";
import { toPublicBooking } from "./booking.routes.js";
import { BOOKING_STATUSES } from "../config/pricing.js";
import {
  parsePagination,
  parsePositiveInteger,
} from "../config/query-validation.js";

const router = Router();

const ROLES = ["Customer", "Owner", "Admin"];

function toPublicUser(doc) {
  if (!doc) return null;

  return {
    id: String(doc.id ?? doc._id),
    name: doc.name ?? "",
    email: doc.email ?? "",
    emailVerified: Boolean(doc.emailVerified),
    image: doc.image ?? "",
    phone: doc.phone ?? "",
    address: doc.address ?? "",
    role:
      typeof doc.role === "string" && doc.role
        ? doc.role
        : "Customer",
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/admin/bookings - Admin only
// Platform-wide rental list. Optional filters:
//   ?status= pending_payment|confirmed|active|completed|cancelled|expired|refunded
//   ?search= customer/owner/equipment name or customer email
//   ?limit=  1..100 (default 100)
router.get(
  "/bookings",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status = "", search = "" } = req.query;

      const filter = {};

      if (typeof status === "string" && status) {
        if (!BOOKING_STATUSES.includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status filter",
          });
        }

        filter.status = status;
      }

      if (
        typeof search === "string" &&
        search.trim()
      ) {
        const safeSearch = escapeRegex(
          search.trim().slice(0, 100)
        );

        const regex = {
          $regex: safeSearch,
          $options: "i",
        };

        filter.$or = [
          { equipmentName: regex },
          { customerName: regex },
          { customerEmail: regex },
          { ownerName: regex },
        ];
      }

      const parsedLimit = parsePositiveInteger(
        req.query.limit,
        {
          name: "limit",
          defaultValue: 100,
          maximum: 100,
          clamp: true,
        }
      );

      if (parsedLimit.error) {
        return res.status(400).json({
          success: false,
          message: parsedLimit.error,
        });
      }

      const limit = parsedLimit.value;

      const collection =
        getDB().collection("booking");

      const total = await collection.countDocuments(
        filter
      );

      const bookings = await collection
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return res.status(200).json({
        success: true,
        count: bookings.length,
        total,
        data: bookings.map(toPublicBooking),
      });
    } catch (error) {
      console.error(
        "Admin booking list error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch bookings",
      });
    }
  }
);

// GET /api/admin/users - Admin only
router.get(
  "/users",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const collection = getDB().collection("user");

      const { search = "", role = "" } = req.query;

      const pagination = parsePagination(
        req.query,
        { defaultLimit: 50, maxLimit: 100 }
      );

      if (pagination.error) {
        return res.status(400).json({
          success: false,
          message: pagination.error,
        });
      }

      const { page, limit } = pagination.value;

      const filter = {};

      if (typeof search === "string" && search.trim()) {
        const safeSearch = escapeRegex(
          search.trim().slice(0, 100)
        );

        filter.$or = [
          { name: { $regex: safeSearch, $options: "i" } },
          { email: { $regex: safeSearch, $options: "i" } },
        ];
      }

      if (typeof role === "string" && role) {
        if (!ROLES.includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role",
          });
        }

        filter.role = role;
      }

      const total = await collection.countDocuments(filter);

      const users = await collection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

      return res.status(200).json({
        success: true,
        count: users.length,
        total,
        page,
        limit,
        data: users.map(toPublicUser),
      });
    } catch (error) {
      console.error("Admin user list error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch users",
      });
    }
  }
);

// GET /api/admin/users/:id - Admin only
router.get(
  "/users/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      const user = await getDB()
        .collection("user")
        .findOne({ _id: new ObjectId(id) });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: toPublicUser(user),
      });
    } catch (error) {
      console.error(
        "Admin user detail error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch user",
      });
    }
  }
);

// PATCH /api/admin/users/:id/role - Admin only
router.patch(
  "/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      const body = req.body;

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
        });
      }

      const { role } = body;

      if (
        typeof role !== "string" ||
        !ROLES.includes(role)
      ) {
        return res.status(400).json({
          success: false,
          message: `role must be one of: ${ROLES.join(", ")}`,
        });
      }

      // Prevent an admin from locking themselves out.
      if (id === req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You cannot change your own role",
        });
      }

      const collection = getDB().collection("user");

      const user = await collection.findOne({
        _id: new ObjectId(id),
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Never allow the last Admin to be demoted.
      if (user.role === "Admin" && role !== "Admin") {
        const otherAdmins = await collection.countDocuments({
          role: "Admin",
          _id: { $ne: user._id },
        });

        if (otherAdmins === 0) {
          return res.status(409).json({
            success: false,
            message:
              "Cannot demote the last Admin account",
          });
        }
      }

      await collection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            role,
            updatedAt: new Date(),
          },
        }
      );

      const updated = await collection.findOne({
        _id: new ObjectId(id),
      });

      return res.status(200).json({
        success: true,
        message: "Role updated",
        user: toPublicUser(updated),
      });
    } catch (error) {
      console.error("Admin role update error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Failed to update role",
      });
    }
  }
);

export default router;
