
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import {
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWKS_URL,
} from "../config/auth.js";

// Public keys published by Better Auth at /api/auth/jwks
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

function unauthorized(res, message = "Authentication token required") {
  return res.status(401).json({
    success: false,
    message,
  });
}

// Verify Bearer JWT against the Better Auth JWKS
export async function verifyToken(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ")
    ) {
      return unauthorized(res);
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return unauthorized(res);
    }

    // Signature, issuer, audience and expiration are all validated here.
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const userId = payload.sub || payload.id;

    if (typeof userId !== "string" || !userId) {
      return unauthorized(res, "Invalid token identity");
    }

    // The role is always read from MongoDB, never from the token.
    const userFilter = /^[a-fA-F0-9]{24}$/.test(userId)
      ? {
          $or: [
            { _id: new ObjectId(userId) },
            { id: userId },
          ],
        }
      : { $or: [{ id: userId }, { _id: userId }] };

    const user = await getDB()
      .collection("user")
      .findOne(userFilter);

    if (!user) {
      return unauthorized(res, "Invalid token");
    }

    req.user = {
      id: String(user.id ?? user._id),
      name: user.name,
      email: user.email,
      role:
        typeof user.role === "string" && user.role
          ? user.role
          : "Customer",
    };

    next();
  } catch (error) {
    // Never leak verification details to the client.
    console.error("JWT verification failed:", error?.message);

    return unauthorized(res, "Invalid or expired token");
  }
}

// Role-based authorization (role comes from MongoDB via verifyToken)
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: insufficient permissions",
      });
    }

    next();
  };
}

export const verifyRenter = requireRole("Customer");
export const verifyOwner = requireRole("Owner");
export const verifyAdmin = requireRole("Admin");
