
import "dotenv/config";
import { connectDB, getDB } from "../config/db.js";

async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();

  if (!email) {
    throw new Error("ADMIN_EMAIL is required");
  }

  if (process.env.CONFIRM_ADMIN_BOOTSTRAP !== "YES") {
    throw new Error(
      "Set CONFIRM_ADMIN_BOOTSTRAP=YES to confirm"
    );
  }

  await connectDB();

  const users = getDB().collection("user");

  // Bootstrap is permitted only before the first Admin exists.
  const existingAdmin = await users.findOne({
    role: "Admin",
  });

  if (existingAdmin) {
    throw new Error(
      "An Admin already exists. Bootstrap is disabled."
    );
  }

  // User must have registered through Better Auth already.
  const user = await users.findOne({
    email,
  });

  if (!user) {
    throw new Error(
      "No registered user found with that email"
    );
  }

  const result = await users.updateOne(
    {
      _id: user._id,
      role: { $ne: "Admin" },
    },
    {
      $set: {
        role: "Admin",
        updatedAt: new Date(),
      },
    }
  );

  if (result.modifiedCount !== 1) {
    throw new Error("Admin promotion was not applied");
  }

  console.log("First Admin configured successfully");
  console.log("Admin Email:", email);
  console.log("Admin Role: Admin");
}

bootstrapAdmin()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Bootstrap failed:", error.message);
    process.exit(1);
  });
