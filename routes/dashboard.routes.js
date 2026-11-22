
import { Router } from "express";
import { getDB } from "../config/db.js";

import {
  verifyToken,
  verifyRenter,
  verifyOwner,
  verifyAdmin,
} from "../middleware/auth.middleware.js";

import {
  releaseStaleBookings,
  advanceBookingStatuses,
} from "../config/booking-lifecycle.js";

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function lastMonths(count) {
  const months = [];
  const now = new Date();

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - i,
      1
    );

    months.push({
      key: `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`,
      label: date.toLocaleString("en-US", {
        month: "short",
        year: "numeric",
      }),
    });
  }

  return months;
}

function bucketByMonth(rows, field = "month") {
  const map = new Map();

  for (const row of rows) {
    map.set(row[field], row.total ?? row.count ?? 0);
  }

  return map;
}

// All authenticated users
router.get("/me", verifyToken, (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
});

// ========================================
// Customer Dashboard
// Real counts straight from MongoDB.
// ========================================
router.get(
  "/customer",
  verifyToken,
  verifyRenter,
  async (req, res) => {
    try {
      const db = getDB();

      // Apply the time based lifecycle first so the counts
      // reflect the real state of the rentals.
      await releaseStaleBookings(db);
      await advanceBookingStatuses(db);

      const [statusRows, favorites, payments] =
        await Promise.all([
          db
            .collection("booking")
            .aggregate([
              { $match: { customerId: req.user.id } },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray(),

          db
            .collection("favorite")
            .countDocuments({ userId: req.user.id }),

          db
            .collection("payment")
            .aggregate([
              {
                $match: {
                  userId: req.user.id,
                  status: "paid",
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray(),
        ]);

      const byStatus = {};

      for (const row of statusRows) {
        byStatus[row._id] = row.count;
      }

      const today = new Date().toISOString().slice(0, 10);

      const [activeRentals, upcoming, recent] =
        await Promise.all([
          db.collection("booking").countDocuments({
            customerId: req.user.id,
            status: "active",
          }),

          db
            .collection("booking")
            .find({
              customerId: req.user.id,
              status: { $in: ["confirmed"] },
              startDate: { $gte: today },
            })
            .sort({ startDate: 1 })
            .limit(5)
            .toArray(),

          db
            .collection("booking")
            .find({ customerId: req.user.id })
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray(),
        ]);

      return res.status(200).json({
        success: true,
        stats: {
          totalBookings: statusRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          byStatus,
          activeRentals,
          upcomingRentals: upcoming.length,
          favorites,
          totalPaid: payments[0]?.total ?? 0,
          paymentCount: payments[0]?.count ?? 0,
        },
        upcoming: upcoming.map((b) => ({
          id: String(b._id),
          equipmentName: b.equipmentName,
          startDate: b.startDate,
          endDate: b.endDate,
          totalAmount: b.totalAmount,
          status: b.status,
        })),
        recentBookings: recent.map((b) => ({
          id: String(b._id),
          equipmentName: b.equipmentName,
          startDate: b.startDate,
          endDate: b.endDate,
          totalAmount: b.totalAmount,
          status: b.status,
          createdAt: b.createdAt,
        })),
      });
    } catch (error) {
      console.error(
        "Customer dashboard error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to load customer dashboard",
      });
    }
  }
);

// ========================================
// Owner Dashboard
// ========================================
router.get(
  "/owner",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const db = getDB();

      await releaseStaleBookings(db);
      await advanceBookingStatuses(db);

      const [equipmentRows, requestRows, earnings] =
        await Promise.all([
          db
            .collection("equipment")
            .aggregate([
              {
                $match: {
                  ownerId: req.user.id,
                  status: { $ne: "removed" },
                },
              },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray(),

          db
            .collection("booking")
            .aggregate([
              { $match: { ownerId: req.user.id } },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray(),

          db
            .collection("booking")
            .aggregate([
              {
                $match: {
                  ownerId: req.user.id,
                  status: {
                    $in: ["confirmed", "active", "completed"],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$totalAmount" },
                },
              },
            ])
            .toArray(),
        ]);

      const equipmentByStatus = {};

      for (const row of equipmentRows) {
        equipmentByStatus[row._id] = row.count;
      }

      const requestsByStatus = {};

      for (const row of requestRows) {
        requestsByStatus[row._id] = row.count;
      }

      // Monthly revenue for the last six months.
      const cutoff = new Date(
        Date.now() - 180 * MS_PER_DAY
      );

      const monthlyRows = await db
        .collection("booking")
        .aggregate([
          {
            $match: {
              ownerId: req.user.id,
              status: {
                $in: ["confirmed", "active", "completed"],
              },
              updatedAt: { $gte: cutoff },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$updatedAt",
                },
              },
              total: { $sum: "$totalAmount" },
            },
          },
        ])
        .toArray();

      const monthlyMap = bucketByMonth(monthlyRows);
      const months = lastMonths(6);

      const pendingRequests =
        (requestsByStatus.pending_payment ?? 0) +
        (requestsByStatus.confirmed ?? 0);

      return res.status(200).json({
        success: true,
        stats: {
          totalEquipment: equipmentRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          pendingEquipment:
            equipmentByStatus.pending ?? 0,
          approvedEquipment:
            equipmentByStatus.approved ?? 0,
          rejectedEquipment:
            equipmentByStatus.rejected ?? 0,
          rentalRequests: requestRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          pendingRequests,
          activeRentals: requestsByStatus.active ?? 0,
          completedRentals:
            requestsByStatus.completed ?? 0,
          totalEarnings: earnings[0]?.total ?? 0,
        },
        monthlyRevenue: months.map((month) => ({
          month: month.key,
          label: month.label,
          total: monthlyMap.get(month.key) ?? 0,
        })),
      });
    } catch (error) {
      console.error(
        "Owner dashboard error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to load owner dashboard",
      });
    }
  }
);

// ========================================
// Admin Dashboard
// ========================================
router.get(
  "/admin",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const db = getDB();

      await releaseStaleBookings(db);
      await advanceBookingStatuses(db);

      const [
        roleRows,
        equipmentRows,
        bookingRows,
        paymentRows,
        signupRows,
        approvalRows,
      ] = await Promise.all([
        db
          .collection("user")
          .aggregate([
            {
              $group: {
                _id: {
                  $ifNull: ["$role", "Customer"],
                },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        db
          .collection("equipment")
          .aggregate([
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        db
          .collection("booking")
          .aggregate([
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        db
          .collection("payment")
          .aggregate([
            {
              $match: { status: "paid" },
            },
            {
              $group: {
                _id: null,
                total: { $sum: "$amount" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        db
          .collection("user")
          .aggregate([
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m",
                    date: "$createdAt",
                  },
                },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        db
          .collection("equipment")
          .countDocuments({ status: "pending" }),
      ]);

      const usersByRole = {};

      for (const row of roleRows) {
        usersByRole[row._id] = row.count;
      }

      const equipmentByStatus = {};

      for (const row of equipmentRows) {
        equipmentByStatus[row._id] = row.count;
      }

      const bookingsByStatus = {};

      for (const row of bookingRows) {
        bookingsByStatus[row._id] = row.count;
      }

      const signupMap = bucketByMonth(signupRows);
      const months = lastMonths(6);

      return res.status(200).json({
        success: true,
        stats: {
          totalUsers: roleRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          usersByRole,
          totalEquipment: equipmentRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          equipmentByStatus,
          pendingApprovals: approvalRows,
          totalBookings: bookingRows.reduce(
            (sum, row) => sum + row.count,
            0
          ),
          bookingsByStatus,
          confirmedPayments: paymentRows[0]?.count ?? 0,
          paymentVolume: paymentRows[0]?.total ?? 0,
        },
        monthlySignups: months.map((month) => ({
          month: month.key,
          label: month.label,
          count: signupMap.get(month.key) ?? 0,
        })),
      });
    } catch (error) {
      console.error(
        "Admin dashboard error:",
        error?.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to load admin dashboard",
      });
    }
  }
);

export default router;
