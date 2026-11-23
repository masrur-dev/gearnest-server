import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePagination,
  parsePositiveInteger,
} from "../config/query-validation.js";

test("pagination uses its documented defaults and caps limit", () => {
  assert.deepEqual(
    parsePagination({}, { defaultLimit: 50, maxLimit: 50 }),
    { value: { page: 1, limit: 50 } }
  );
  assert.deepEqual(
    parsePagination(
      { page: "3", limit: "80" },
      { defaultLimit: 50, maxLimit: 50 }
    ),
    { value: { page: 3, limit: 50 } }
  );
});

test("pagination rejects malformed and unsafe values", () => {
  for (const page of ["1.5", "2abc", "-1", "0", "9007199254740992"]) {
    assert.match(
      parsePagination(
        { page },
        { defaultLimit: 50, maxLimit: 50 }
      ).error,
      /page/
    );
  }

  assert.match(
    parsePagination(
      { limit: ["10", "20"] },
      { defaultLimit: 50, maxLimit: 50 }
    ).error,
    /limit/
  );
});

test("single-value limits reject malformed input and clamp valid input", () => {
  assert.deepEqual(
    parsePositiveInteger("150", {
      name: "limit",
      defaultValue: 100,
      maximum: 100,
      clamp: true,
    }),
    { value: 100 }
  );
  assert.match(
    parsePositiveInteger("5x", {
      name: "limit",
      defaultValue: 100,
      maximum: 100,
      clamp: true,
    }).error,
    /limit/
  );
});
