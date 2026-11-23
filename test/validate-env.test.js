import test from "node:test";
import assert from "node:assert/strict";

import { validateEnvironment } from "../config/validate-env.js";

const validEnvironment = {
  MONGODB_URI: "mongodb://localhost:27017/gearnest",
  BETTER_AUTH_SECRET: "a-secure-local-test-secret-with-32-bytes",
  BETTER_AUTH_URL: "http://localhost:5000",
  CLIENT_URL: "http://localhost:3000",
};

test("valid required configuration and paired OAuth credentials pass", () => {
  assert.equal(
    validateEnvironment({
      ...validEnvironment,
      MONGODB_URI:
        "mongodb+srv://db-user:db-password@cluster.example/gearnest?retryWrites=true",
      PORT: "5000",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
    }),
    true
  );
});

test("missing and short auth secrets fail without echoing secret contents", () => {
  assert.throws(
    () =>
      validateEnvironment({
        ...validEnvironment,
        BETTER_AUTH_SECRET: "short-secret",
      }),
    (error) =>
      error.message.includes(
        "BETTER_AUTH_SECRET must be at least 32 bytes"
      ) && !error.message.includes("short-secret")
  );

  assert.throws(
    () =>
      validateEnvironment({
        MONGODB_URI: validEnvironment.MONGODB_URI,
      }),
    /BETTER_AUTH_SECRET is required/
  );
});

test("invalid service URLs, Mongo URI, and port fail validation", () => {
  assert.throws(
    () =>
      validateEnvironment({
        ...validEnvironment,
        MONGODB_URI: "https://database.example",
        CLIENT_URL: "javascript:alert(1)",
        PORT: "70000",
      }),
    (error) =>
      error.message.includes("MONGODB_URI") &&
      error.message.includes("CLIENT_URL") &&
      error.message.includes("PORT")
  );
});

test("OAuth client credentials must be configured as a pair", () => {
  assert.throws(
    () =>
      validateEnvironment({
        ...validEnvironment,
        GOOGLE_CLIENT_ID: "client-id",
      }),
    /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/
  );

  assert.throws(
    () =>
      validateEnvironment({
        ...validEnvironment,
        GITHUB_CLIENT_ID: " ",
        GITHUB_CLIENT_SECRET: " ",
      }),
    /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET cannot be blank/
  );
});
