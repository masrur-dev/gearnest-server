
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

const ALLOWED_FIELDS = ["name", "image", "phone", "address"];

const PROTECTED_FIELDS = [
  "id",
  "_id",
  "email",
  "emailVerified",
  "role",
  "password",
  "createdAt",
  "updatedAt",
];

// Safe projection returned to clients
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

function stripControlChars(value) {
  // Intentional: strip C0/C1 control characters from input.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

function validateTextField(value, { label, max, min = 0, pattern }) {
  if (typeof value !== "string") {
    return { error: `${label} must be a string` };
  }

  const cleaned = stripControlChars(value).trim();

  if (cleaned.length > max) {
    return {
      error: `${label} must be at most ${max} characters`,
    };
  }

  if (cleaned.length < min) {
    return {
      error: `${label} must be at least ${min} characters`,
    };
  }

  if (cleaned && pattern && !pattern.test(cleaned)) {
    return { error: `${label} format is invalid` };
  }

  return { value: cleaned };
}

function validateField(field, value) {
  switch (field) {
    case "name":
      return validateTextField(value, {
        label: "name",
        min: 1,
        max: 100,
      });

    case "image": {
      const result = validateTextField(value, {
        label: "image",
        max: 500,
      });

      if (result.error) return result;

      if (
        result.value &&
        !/^(https?:\/\/|\/)\S+$/i.test(result.value)
      ) {
        return {
          error:
            "image must be an http(s) URL or a relative path",
        };
      }

      return result;
    }

    case "phone": {
      const result = validateTextField(value, {
        label: "phone",
        max: 30,
      });

      if (result.error) return result;

      if (!result.value) return result;

      const digits = result.value.replace(/\D/g, "");

      if (
        digits.length < 5 ||
        digits.length > 15 ||
        !/^\+?[\d\s\-()]+$/.test(result.value)
      ) {
        return { error: "phone format is invalid" };
      }

      return result;
    }

    case "address":
      return validateTextField(value, {
        label: "address",
        max: 300,
      });

    default:
      return { error: `Field "${field}" is not allowed` };
  }
}

// GET /api/users/me - own profile
router.get("/me", verifyToken, async (req, res) => {
  try {
    if (!/^[a-fA-F0-9]{24}$/.test(req.user.id)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const user = await getDB()
      .collection("user")
      .findOne({ _id: new ObjectId(req.user.id) });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    return res.status(200).json({
      success: true,
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error("Profile fetch error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
    });
  }
});

// PATCH /api/users/me - update own profile
// Only name, image, phone and address may be changed.
router.patch("/me", verifyToken, async (req, res) => {
  try {
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

    const keys = Object.keys(body);

    if (keys.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    for (const key of keys) {
      if (
        PROTECTED_FIELDS.includes(key) ||
        !ALLOWED_FIELDS.includes(key)
      ) {
        return res.status(400).json({
          success: false,
          message: `Field "${key}" is not allowed`,
        });
      }
    }

    const updates = {};

    for (const key of keys) {
      const result = validateField(key, body[key]);

      if (result.error) {
        return res.status(400).json({
          success: false,
          message: result.error,
        });
      }

      updates[key] = result.value;
    }

    if (!/^[a-fA-F0-9]{24}$/.test(req.user.id)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const result = await getDB()
      .collection("user")
      .updateOne(
        { _id: new ObjectId(req.user.id) },
        {
          $set: {
            ...updates,
            updatedAt: new Date(),
          },
        }
      );

    if (result.matchedCount === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const user = await getDB()
      .collection("user")
      .findOne({ _id: new ObjectId(req.user.id) });

    return res.status(200).json({
      success: true,
      message: "Profile updated",
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error("Profile update error:", error?.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile",
    });
  }
});

export default router;
