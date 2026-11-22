
// Vercel serverless entrypoint.
// The whole Express app is mounted here; vercel.json rewrites
// every path to this function. Locally use `npm run dev`.

import { createApp } from "../app.js";

let appPromise = null;

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      appPromise = null;
      throw error;
    });
  }

  const app = await appPromise;

  return app(req, res);
}
