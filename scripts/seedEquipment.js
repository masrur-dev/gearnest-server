
import "dotenv/config";
import { MongoClient } from "mongodb";

const equipment = [
  {
    name: "Canon EOS R6 Mark II",
    description: "Full-frame mirrorless camera for professional photography.",
    category: "Photography",
    rentalPrice: 45,
    rentalType: "Daily",
    location: "New York, USA",
    availableQuantity: 5,
    condition: "Excellent",
    brand: "Canon",
    model: "EOS R6 Mark II",
    image: "",
    rentalTerms: "Return in original condition.",
    status: "approved",
  },
  {
    name: "CAT 320 Excavator",
    description: "Heavy-duty excavator for construction projects.",
    category: "Construction",
    rentalPrice: 250,
    rentalType: "Daily",
    location: "Texas, USA",
    availableQuantity: 3,
    condition: "Good",
    brand: "Caterpillar",
    model: "320",
    image: "",
    rentalTerms: "Qualified operators only.",
    status: "approved",
  },
  {
    name: "Ford Transit Cargo Van",
    description: "Spacious commercial van for transportation.",
    category: "Transportation",
    rentalPrice: 110,
    rentalType: "Daily",
    location: "California, USA",
    availableQuantity: 4,
    condition: "Excellent",
    brand: "Ford",
    model: "Transit",
    image: "",
    rentalTerms: "Valid driving license required.",
    status: "approved",
  },
  {
    name: "John Deere 5075E Tractor",
    description: "Utility tractor for agricultural work.",
    category: "Agriculture",
    rentalPrice: 180,
    rentalType: "Daily",
    location: "Ohio, USA",
    availableQuantity: 2,
    condition: "Good",
    brand: "John Deere",
    model: "5075E",
    image: "",
    rentalTerms: "Experienced operators only.",
    status: "approved",
  },
  {
    name: "Apple MacBook Pro 14",
    description: "High-performance laptop for creative projects.",
    category: "Electronics",
    rentalPrice: 55,
    rentalType: "Daily",
    location: "Seattle, USA",
    availableQuantity: 6,
    condition: "Excellent",
    brand: "Apple",
    model: "MacBook Pro 14",
    image: "",
    rentalTerms: "Return with all included accessories.",
    status: "approved",
  },
  {
    name: "JBL PRX815 Speaker",
    description: "Professional powered speaker for events.",
    category: "Events",
    rentalPrice: 75,
    rentalType: "Daily",
    location: "Florida, USA",
    availableQuantity: 8,
    condition: "Excellent",
    brand: "JBL",
    model: "PRX815",
    image: "",
    rentalTerms: "Avoid water exposure and physical damage.",
    status: "approved",
  },
];

const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();

  const collection = client
    .db("gearnestDB")
    .collection("equipment");

  const result = await collection.bulkWrite(
    equipment.map((item) => {
      const { image, ...fields } = item;

      return {
        updateOne: {
          filter: {
            name: item.name,
            ownerId: "demo-owner",
          },
          update: {
            $set: {
              ...fields,
              ...(image ? { image } : {}),
              ownerName: "GearNest Demo",
              ownerEmail: "demo@example.com",
              updatedAt: new Date(),
            },
            $setOnInsert: {
              ownerId: "demo-owner",
              createdAt: new Date(),
              ...(!image ? { image: "" } : {}),
            },
          },
          upsert: true,
        },
      };
    })
  );

  console.log("Equipment seeded successfully!");
  console.log("Inserted:", result.upsertedCount);
  console.log("Updated:", result.modifiedCount);
  console.log("Matched:", result.matchedCount);

} catch (error) {
  console.error("Seeding failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
