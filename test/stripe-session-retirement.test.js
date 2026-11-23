import test from "node:test";
import assert from "node:assert/strict";

import {
  retireOpenCheckoutSession,
} from "../services/stripe-services.js";

function fakeStripe({ expire, retrieve }) {
  return {
    checkout: {
      sessions: {
        expire,
        retrieve,
      },
    },
  };
}

test("retirement accepts Stripe confirmation without another lookup", async () => {
  let retrieveCalls = 0;
  const stripe = fakeStripe({
    expire: async () => ({ status: "expired" }),
    retrieve: async () => {
      retrieveCalls += 1;
      return { status: "open" };
    },
  });

  assert.equal(
    await retireOpenCheckoutSession(stripe, "cs_test"),
    "expired"
  );
  assert.equal(retrieveCalls, 0);
});

test("retirement checks Stripe state after an expiration error", async () => {
  const stripe = fakeStripe({
    expire: async () => {
      throw new Error("request timed out");
    },
    retrieve: async () => ({ status: "expired" }),
  });

  assert.equal(
    await retireOpenCheckoutSession(stripe, "cs_test"),
    "expired"
  );
});

test("an open session after a failed expiration blocks replacement", async () => {
  const stripe = fakeStripe({
    expire: async () => {
      throw new Error("request timed out");
    },
    retrieve: async () => ({ status: "open" }),
  });

  await assert.rejects(
    retireOpenCheckoutSession(stripe, "cs_test"),
    /request timed out/
  );
});

test("a completed session is never treated as safely expired", async () => {
  const stripe = fakeStripe({
    expire: async () => {
      throw new Error("already completed");
    },
    retrieve: async () => ({ status: "complete" }),
  });

  assert.equal(
    await retireOpenCheckoutSession(stripe, "cs_test"),
    "complete"
  );
});
