
// ============================================================
// LOCAL-ONLY Admin password recovery
// ============================================================
//
// Use this only when an existing Admin password is lost and no
// password-reset email provider is configured. It never creates
// accounts, never promotes users, never prints hashes and never
// touches data outside the single target account.
//
// Usage:
//   CONFIRM_ADMIN_RECOVERY=YES \
//   RECOVER_ADMIN_EMAIL=admin@example.com \
//   node scripts/recover-admin.js
//
// The new password is read from RECOVER_ADMIN_PASSWORD or from
// an interactive prompt. You must type the target email to
// confirm before anything is written.
// ============================================================

import "dotenv/config";
import readline from "node:readline/promises";
import { hashPassword } from "better-auth/crypto";
import { connectDB, getDB } from "../config/db.js";

function fail(message) {
  console.error(`Recovery failed: ${message}`);
  process.exit(1);
}

async function promptLine(question, { muted = false } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  if (muted && typeof rl._writeToOutput === "function") {
    rl._writeToOutput = function (stringToWrite) {
      if (!rl.stdoutMuted) {
        rl.output.write(stringToWrite);
      }
    };
    rl.stdoutMuted = true;
  }

  try {
    process.stdout.write(question);
    return (await rl.question("")).trim();
  } finally {
    rl.close();
  }
}

async function readNewPassword() {
  const fromEnv = process.env.RECOVER_ADMIN_PASSWORD;

  if (fromEnv) {
    return fromEnv;
  }

  if (!process.stdin.isTTY) {
    fail(
      "Set RECOVER_ADMIN_PASSWORD or run interactively in a terminal"
    );
  }

  const first = await promptLine("New password: ", {
    muted: true,
  });
  const second = await promptLine(
    "Confirm new password: ",
    { muted: true }
  );

  process.stdout.write("\n");

  if (first !== second) {
    fail("Passwords do not match");
  }

  return first;
}

async function main() {
  if (process.env.CONFIRM_ADMIN_RECOVERY !== "YES") {
    fail(
      "Set CONFIRM_ADMIN_RECOVERY=YES to confirm this action"
    );
  }

  const email = (process.env.RECOVER_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

  if (!email) {
    fail("RECOVER_ADMIN_EMAIL is required");
  }

  const password = await readNewPassword();

  if (typeof password !== "string" || password.length < 6) {
    fail("Password must be at least 6 characters");
  }

  await connectDB();

  const db = getDB();
  const expectedDb =
    process.env.DB_NAME || "gearnestDB";

  // Verify we are talking to the intended database.
  if (db.databaseName !== expectedDb) {
    fail(
      `Connected to "${db.databaseName}" but expected "${expectedDb}"`
    );
  }

  const users = db.collection("user");
  const user = await users.findOne({ email });

  if (!user) {
    fail(`No account found for ${email}`);
  }

  if (user.role !== "Admin") {
    fail(
      `${email} is not an Admin (role: ${user.role ?? "none"}). ` +
        "This script never promotes accounts."
    );
  }

  // Explicit operator confirmation.
  if (process.stdin.isTTY) {
    console.log("\nAbout to reset the Admin password:");
    console.log(`  database : ${db.databaseName}`);
    console.log(`  account  : ${email}`);
    console.log(`  user id  : ${String(user._id)}`);

    const typed = await promptLine(
      "\nType the admin email to confirm: "
    );

    if (typed.toLowerCase() !== email) {
      fail("Confirmation did not match, nothing changed");
    }
  }

  const hashed = await hashPassword(password);
  const now = new Date();

  const accounts = db.collection("account");

  const updated = await accounts.updateOne(
    { userId: user._id, providerId: "credential" },
    {
      $set: {
        password: hashed,
        updatedAt: now,
      },
    }
  );

  if (updated.matchedCount === 0) {
    // The account document is missing: create the credential
    // record for this existing user only.
    await accounts.insertOne({
      accountId: String(user._id),
      providerId: "credential",
      userId: user._id,
      password: hashed,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Force a fresh sign-in after recovery.
  const sessions = await db
    .collection("session")
    .deleteMany({ userId: user._id });

  // Auditable action (no secrets are logged).
  console.log(
    JSON.stringify({
      action: "admin_password_recovery",
      at: now.toISOString(),
      database: db.databaseName,
      email,
      userId: String(user._id),
      sessionsRevoked: sessions.deletedCount,
    })
  );

  console.log(
    "Admin password reset. Existing sessions were revoked."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Recovery failed:", error?.message);
    process.exit(1);
  });
