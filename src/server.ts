import { existsSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { createApp } from "./app";
import { isPlaceholderEnv } from "./lib/supabaseAdmin";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
  if (process.env.NODE_ENV !== "production") {
    // Reload .env edits automatically while running `npm run dev`
    watchFile(envPath, { interval: 1000 }, () => {
      dotenv.config({ path: envPath, override: true });
      console.log("[eventra-backend] Reloaded .env configuration.");
    });
  }
}

const port = Number(process.env.PORT || 4000);

const missingRequired = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
  (key) => isPlaceholderEnv(process.env[key]),
);

if (missingRequired.length > 0) {
  console.warn(
    `[eventra-backend] Warning: Set valid ${missingRequired.join(", ")} in backend/.env (placeholders detected). Database requests will fail until set.`,
  );
}

const app = createApp();

app.listen(port, () => {
  console.log(`[eventra-backend] Listening on http://localhost:${port}`);
});

