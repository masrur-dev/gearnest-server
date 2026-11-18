
import "dotenv/config";

import express from "express";
import cors from "cors";

import ownerRoutes from "./routes/owner.routes.js";

import {
  toNodeHandler,
  fromNodeHeaders,
} from "better-auth/node";

import { connectDB, getDB } from "./config/db.js";
import { createAuth } from "./config/auth.js";

import equipmentRoutes from "./routes/equipment.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";

const app = express();
const port = process.env.PORT || 5000;

app.disable("x-powered-by");

// CORS Middleware
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

// Start Server
async function startServer() {
  try {
    // Connect MongoDB
    await connectDB();

    // Initialize Better Auth
    const auth = createAuth(getDB());

    // Better Auth routes
    // Must be registered before express.json()
    app.all(
      "/api/auth/*splat",
      toNodeHandler(auth)
    );

    // JSON Middleware
    app.use(express.json());

    // Server Health Check
    app.get("/", (req, res) => {
      return res.status(200).json({
        success: true,
        message: "GearNest API is running",
      });
    });
    app.use("/api/owner", ownerRoutes);

    // Authenticated User Session
    app.get("/api/me", async (req, res) => {
      try {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });

        if (!session) {
          return res.status(401).json({
            success: false,
            message: "Unauthorized",
          });
        }

        return res.status(200).json({
          success: true,
          user: session.user,
        });
      } catch (error) {
        console.error("Session Error:", error);

        return res.status(500).json({
          success: false,
          message: "Failed to check session",
        });
      }
    });

    // Equipment Routes
    app.use(
      "/api/equipment",
      equipmentRoutes
    );

    // Protected Dashboard Routes
    app.use(
      "/api/dashboard",
      dashboardRoutes
    );

    // Protected User Profile Routes
    app.use(
      "/api/users",
      userRoutes
    );

    // Protected Admin Routes
    app.use(
      "/api/admin",
      adminRoutes
    );

    // Unknown API routes
    app.use((req, res) => {
      return res.status(404).json({
        success: false,
        message: "Not found",
      });
    });

    // Error handler (keeps internal details out of responses)
    app.use((error, req, res, next) => {
      if (error?.type === "entity.parse.failed") {
        return res.status(400).json({
          success: false,
          message: "Invalid JSON body",
        });
      }

      console.error("Unhandled error:", error?.message);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    });

    // Start Express
    app.listen(port, () => {
      console.log(
        `GearNest Server running on port ${port}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
