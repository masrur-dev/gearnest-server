
// Time based booking lifecycle shared by the booking routes and
// the dashboards. A booking holds its dates for 30 minutes while
// the customer completes payment; after that it expires lazily on
// the next read. No Stripe calls happen here: if money still
// arrives later, the webhook refunds it.

export const PENDING_PAYMENT_TTL_MS =
  30 * 60 * 1000;

// Expire unpaid bookings so their dates become available again.
export async function releaseStaleBookings(db) {
  const cutoff = new Date(
    Date.now() - PENDING_PAYMENT_TTL_MS
  );

  const result = await db
    .collection("booking")
    .updateMany(
      {
        status: "pending_payment",
        createdAt: { $lt: cutoff },
      },
      {
        $set: {
          status: "expired",
          updatedAt: new Date(),
        },
      }
    );

  return result.modifiedCount;
}

// Time based lifecycle: confirmed -> active -> completed.
export async function advanceBookingStatuses(db) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  await db.collection("booking").updateMany(
    { status: "confirmed", startDate: { $lte: today } },
    { $set: { status: "active", updatedAt: now } }
  );

  await db.collection("booking").updateMany(
    { status: "active", endDate: { $lt: today } },
    { $set: { status: "completed", updatedAt: now } }
  );
}
