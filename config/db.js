
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri);

export { client };

let db;

export async function connectDB() {
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
