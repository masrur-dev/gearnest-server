
// Creates the MongoDB indexes used by the GearNest APIs.
// Safe to run repeatedly: existing indexes are left alone.

import "dotenv/config";
import { connectDB, getDB } from "../config/db.js";

const INDEXES = {
  equipment: [
    { key: { status: 1, createdAt: -1 }, name: "equipment_status_created" },
    { key: { category: 1 }, name: "equipment_category" },
    { key: { rentalPrice: 1 }, name: "equipment_price" },
    { key: { ownerId: 1, createdAt: -1 }, name: "equipment_owner" },
    { key: { location: 1 }, name: "equipment_location" },
  ],
  booking: [
    { key: { customerId: 1, createdAt: -1 }, name: "booking_customer" },
    { key: { ownerId: 1, createdAt: -1 }, name: "booking_owner" },
    {
      key: { equipmentId: 1, status: 1, startDate: 1, endDate: 1 },
      name: "booking_availability",
    },
    { key: { status: 1, createdAt: 1 }, name: "booking_status_created" },
    { key: { stripeSessionId: 1 }, name: "booking_session", sparse: true },
  ],
  favorite: [
    {
      key: { userId: 1, equipmentId: 1 },
      name: "favorite_user_equipment",
      unique: true,
    },
  ],
  review: [
    {
      key: { bookingId: 1, userId: 1 },
      name: "review_booking_user",
      unique: true,
    },
    { key: { equipmentId: 1, createdAt: -1 }, name: "review_equipment" },
  ],
  payment: [
    {
      key: { stripeSessionId: 1 },
      name: "payment_session_uidx",
      unique: true,
      sparse: true,
    },
    {
      key: { stripeEventId: 1 },
      name: "payment_event_uidx",
      unique: true,
      sparse: true,
    },
    { key: { userId: 1, createdAt: -1 }, name: "payment_user" },
    { key: { bookingId: 1 }, name: "payment_booking", sparse: true },
  ],
};

async function main() {
  await connectDB();

  const db = getDB();

  for (const [collection, indexes] of Object.entries(INDEXES)) {
    for (const index of indexes) {
      const options = { name: index.name };

      if (index.unique) options.unique = true;
      if (index.sparse) options.sparse = true;

      try {
        await db
          .collection(collection)
          .createIndex(index.key, options);

        console.log(
          `ok  ${collection}.${index.name}`
        );
      } catch (error) {
        console.error(
          `fail ${collection}.${index.name}: ${error?.message}`
        );
        process.exitCode = 1;
      }
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error("Index creation failed:", error?.message);
    process.exit(1);
  });
