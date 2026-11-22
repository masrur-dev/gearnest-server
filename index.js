
import "dotenv/config";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 5000;

createApp()
  .then((app) => {
    app.listen(PORT, () => {
      console.log(
        `GearNest Server running on port ${PORT}`
      );
    });
  })
  .catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
  });
