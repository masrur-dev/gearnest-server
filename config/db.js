
import { MongoClient } from "mongodb";

let client;

export { client };

let db;

export async function connectDB() {
  const connectionString = process.env.MONGODB_URI;

  if (!connectionString) {
    throw new Error("MONGODB_URI is missing");
  }

  client ??= new MongoClient(connectionString);
  await client.connect();

  db = client.db(process.env.DB_NAME || "gearnestDB");
  await db.command({ ping: 1 });

  console.log("MongoDB connected successfully");
}

export function getDB() {
  if (!db) {
    throw new Error("Database is not connected");
  }

  return db;
}
