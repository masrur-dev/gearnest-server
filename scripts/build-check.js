
// Build check: syntax-checks every JavaScript file, then loads
// the application module graph (imports + top-level code).
// Nothing listens on a port and no database connection is made.
//
//   npm run build

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".vercel",
  ".git",
  "coverage",
]);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        collect(full, out);
      }
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }

  return out;
}

const files = collect(root);
let failures = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], {
      stdio: "pipe",
    });
  } catch (error) {
    failures += 1;
    console.error(
      `SYNTAX FAIL  ${path.relative(root, file)}`
    );
    console.error(
      String(error.stderr ?? error.message).trim()
    );
  }
}

// Load both entry points: local dev (app.js) and the Vercel
// serverless handler. Importing them executes every route,
// config and service module in the graph.
for (const entry of ["app.js", "api/index.js"]) {
  try {
    await import(
      pathToFileURL(path.join(root, entry)).href
    );
    console.log(`IMPORT OK    ${entry}`);
  } catch (error) {
    failures += 1;
    console.error(`IMPORT FAIL  ${entry}:`, error.message);
  }
}

if (failures > 0) {
  console.error(`\nBuild check failed: ${failures} problem(s)`);
  process.exit(1);
}

console.log(
  `\nBuild check OK: ${files.length} files syntax-checked`
);
