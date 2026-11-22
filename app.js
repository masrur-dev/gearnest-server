
import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import {
  toNodeHandler,
  fromNodeHeaders,
} from "better-auth/node";

import { connectDB, getDB } from "./config/db.js";
import { createAuth } from "./config/auth.js";
import { verifyToken } from "./middleware/auth.middleware.js";

import equipmentApprovalRoutes from "./routes/equipment-approval.routes.js";
import roleManagementRoutes from "./routes/role-management.routes.js";
import ownerRoutes from "./routes/owner.routes.js";
import equipmentRoutes from "./routes/equipment.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import favoriteRoutes from "./routes/favorite.routes.js";
import reviewRoutes from "./routes/review.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";

import {
  createPaymentRouter,
  createPaymentWebhookRouter,
} from "./routes/payments.routes.js";

// Reuse one app instance for local development and Vercel.
let appPromise = null;

export function createApp() {
  if (!appPromise) {
    appPromise = buildApp().catch((error) => {
      appPromise = null;
      throw error;
    });
  }

  return appPromise;
}

async function buildApp() {
  // Connect MongoDB first.
  await connectDB();

  const db = getDB();
  const auth = createAuth(db);
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Security
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    })
  );

  // CORS
  app.use(
    cors({
      origin:
        process.env.CLIENT_URL ||
        "http://localhost:3000",
      credentials: true,
      methods: [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
      ],
    })
  );

  // Auth rate limiter
  app.use(
    "/api/auth",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many requests, try again later",
      },
    })
  );

  // General API rate limiter
  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 500,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many requests, try again later",
      },
    })
  );

  // Better Auth must be registered before express.json().
  app.all(
    "/api/auth/*splat",
    toNodeHandler(auth)
  );

  // Stripe Webhook must receive the RAW request body.
  // The webhook router performs signature verification.
  // It must be registered BEFORE express.json().
  app.use(
    "/api/payments/webhook",
    createPaymentWebhookRouter({ db })
  );

  // Parse JSON for the remaining API routes.
  app.use(
    express.json({
      limit: "1mb",
    })
  );

  // ==========================
  // HEALTH CHECK
  // ==========================

  app.get("/", (req, res) => {
    return res.status(200).json({
      success: true,
      message: "GearNest API is running",
    });
  });

  app.get("/api/health", (req, res) => {
    return res.status(200).json({
      success: true,
      message: "GearNest API is running",
      uptime: Math.round(process.uptime()),
    });
  });

  // ==========================
  // AUTHENTICATED USER
  // ==========================

  app.get("/api/me", async (req, res) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (session?.user) {
        return res.status(200).json({
          success: true,
          user: session.user,
        });
      }
    } catch (error) {
      console.error(
        "Session Error:",
        error?.message
      );
    }

    // Fallback: Bearer JWT
    return verifyToken(req, res, () => {
      return res.status(200).json({
        success: true,
        user: req.user,
      });
    });
  });

  // ==========================
  // ADMIN ROUTES
  // ==========================

  app.use(
    "/api/admin/approvals",
    equipmentApprovalRoutes
  );

  app.use(
    "/api/admin/role-management",
    roleManagementRoutes
  );

  app.use(
    "/api/admin",
    adminRoutes
  );

  // ==========================
  // OWNER ROUTES
  // ==========================

  app.use(
    "/api/owner",
    ownerRoutes
  );

  // ==========================
  // EQUIPMENT ROUTES
  // ==========================

  app.use(
    "/api/equipment",
    equipmentRoutes
  );

  // ==========================
  // BOOKING ROUTES
  // ==========================

  app.use(
    "/api/bookings",
    bookingRoutes
  );

  // ==========================
  // STRIPE PAYMENT ROUTES
  // ==========================

  // Authenticated Stripe Checkout Session
  app.use(
    "/api/payments",
    createPaymentRouter({
      db,
      verifyToken,
    })
  );

  // Existing Payment Routes
  // Preserve existing endpoints.
  app.use(
    "/api/payments",
    paymentRoutes
  );

  // ==========================
  // FAVORITES
  // ==========================

  app.use(
    "/api/favorites",
    favoriteRoutes
  );

  // ==========================
  // REVIEWS
  // ==========================

  app.use(
    "/api/reviews",
    reviewRoutes
  );

  // ==========================
  // DASHBOARD
  // ==========================

  app.use(
    "/api/dashboard",
    dashboardRoutes
  );

  // ==========================
  // USER ROUTES
  // ==========================

  app.use(
    "/api/users",
    userRoutes
  );

  // ==========================
  // NOT FOUND HANDLER
  // ==========================

  app.use((req, res) => {
    return res.status(404).json({
      success: false,
      message: "Not found",
    });
  });

  // ==========================
  // GLOBAL ERROR HANDLER
  // ==========================

  app.use((error, req, res, next) => {
    if (
      error?.type === "entity.parse.failed"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    console.error(
      "Unhandled error:",
      error?.message
    );

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  });

  return app;
}
