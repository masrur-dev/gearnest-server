
// Shared rental pricing rules.
//
// `rentalPrice` is the price of ONE unit of the equipment for
// ONE rental period of the equipment's `rentalType`.
//
//   Daily   -> one unit = one calendar day
//   Weekly  -> one unit = seven calendar days
//   Monthly -> one unit = thirty calendar days
//
// Dates are calendar dates in YYYY-MM-DD form and both ends of
// the range are inclusive (2026-01-01 -> 2026-01-01 is 1 day).

export const RENTAL_TYPES = ["Daily", "Weekly", "Monthly"];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const MAX_RENTAL_DAYS = 365;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // Reject values such as 2026-02-31 that JS silently rolls over.
  if (date.toISOString().slice(0, 10) !== value) {
    return null;
  }

  return date;
}

// Inclusive calendar days between two dates.
export function rentalDays(startDate, endDate) {
  const diff = endDate.getTime() - startDate.getTime();

  return Math.round(diff / MS_PER_DAY) + 1;
}

// Billing units for the given rental type.
export function rentalUnits(rentalType, days) {
  if (rentalType === "Weekly") {
    return Math.ceil(days / DAYS_PER_WEEK);
  }

  if (rentalType === "Monthly") {
    return Math.ceil(days / DAYS_PER_MONTH);
  }

  return days;
}

// Server-side price calculation. The client never sends the total.
export function calculateRentalCost({
  rentalPrice,
  rentalType,
  startDate,
  endDate,
  quantity,
}) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  if (!start || !end) {
    return { error: "Dates must be valid YYYY-MM-DD values" };
  }

  if (end < start) {
    return { error: "End date must be on or after the start date" };
  }

  const days = rentalDays(start, end);

  if (days > MAX_RENTAL_DAYS) {
    return {
      error: `Rentals are limited to ${MAX_RENTAL_DAYS} days`,
    };
  }

  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    return { error: "quantity must be an integer of at least 1" };
  }

  if (
    typeof rentalPrice !== "number" ||
    !Number.isFinite(rentalPrice) ||
    rentalPrice <= 0
  ) {
    return { error: "Equipment has an invalid rental price" };
  }

  if (!RENTAL_TYPES.includes(rentalType)) {
    return { error: "Invalid rental type" };
  }

  const units = rentalUnits(rentalType, days);
  const total = Number(
    (rentalPrice * units * quantity).toFixed(2)
  );

  return {
    value: {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      days,
      units,
      unitPrice: rentalPrice,
      quantity,
      totalAmount: total,
      currency: "usd",
    },
  };
}

// Booking states that hold inventory.
export const OCCUPYING_STATUSES = [
  "pending_payment",
  "confirmed",
  "active",
];

// Booking states a customer may cancel.
export const CUSTOMER_CANCELLABLE = [
  "pending_payment",
  "confirmed",
];

export const BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "active",
  "completed",
  "cancelled",
  "expired",
  "refunded",
];

// True when two inclusive date ranges share at least one day.
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}
