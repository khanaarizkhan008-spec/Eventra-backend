import cors from "cors";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { asyncHandler, sendError } from "./lib/http";
import { isPlaceholderEnv } from "./lib/supabaseAdmin";
import { adminRouter } from "./routes/admin";
import { organizerRouter } from "./routes/organizer";
import { paymentsRouter } from "./routes/payments";
import { registrationsRouter } from "./routes/registrations";
import { ticketsRouter } from "./routes/tickets";
import { cashfreeWebhookHandler } from "./routes/webhooks";

function parseAllowedOrigins(): string[] | "*" {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === "*") return "*";
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const appBaseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (appBaseUrl && !list.includes(appBaseUrl)) {
    list.push(appBaseUrl);
  }
  return list.length > 0 ? list : "*";
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  const allowedOrigins = parseAllowedOrigins();
  app.use(
    cors({
      origin: allowedOrigins === "*" ? "*" : allowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "apikey",
        "x-client-info",
        "x-cron-secret",
      ],
    }),
  );

  // Health & root status endpoints for Render
  const healthHandler = (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "eventra-backend",
      configured: {
        supabase:
          !isPlaceholderEnv(process.env.SUPABASE_URL) &&
          !isPlaceholderEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
        cashfree: Boolean(
          process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY,
        ),
      },
      timestamp: new Date().toISOString(),
    });
  };
  app.get("/", healthHandler);
  app.get("/health", healthHandler);

  // Webhook MUST run before express.json() so raw unmodified bytes reach HMAC-SHA256 verification
  app.post(
    ["/api/cashfree-webhook", "/functions/v1/cashfree-webhook"],
    express.raw({ type: "*/*", limit: "1mb" }),
    asyncHandler(cashfreeWebhookHandler),
  );
  app.all(["/api/cashfree-webhook", "/functions/v1/cashfree-webhook"], (_req, res) => {
    sendError(res, "Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  });

  app.use(express.json({ limit: "1mb" }));

  const apiRouter = Router();
  apiRouter.use(registrationsRouter);
  apiRouter.use(paymentsRouter);
  apiRouter.use(ticketsRouter);
  apiRouter.use(adminRouter);
  apiRouter.use(organizerRouter);

  // Support both clean /api/* and drop-in /functions/v1/* endpoints
  app.use("/api", apiRouter);
  app.use("/functions/v1", apiRouter);

  app.use((_req, res) => {
    sendError(res, "Endpoint not found.", 404, "NOT_FOUND");
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message =
        err instanceof Error ? err.message : "Internal server error.";
      sendError(res, message, 500, "INTERNAL_ERROR");
    },
  );

  return app;
}

