import type { NextFunction, Request, Response } from "express";
import { HttpAuthError } from "./supabaseAdmin";

export function sendError(
  res: Response,
  message: string,
  status = 400,
  code = "BAD_REQUEST",
  extra?: Record<string, unknown>,
): Response {
  return res.status(status).json({
    ok: false,
    error: message,
    code,
    ...(extra ?? {}),
  });
}

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/** Wraps async Express handlers to map HttpAuthError and unexpected errors cleanly to JSON. */
export function asyncHandler(fn: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err instanceof HttpAuthError) {
        sendError(res, err.message, err.status, "AUTH_ERROR");
        return;
      }
      const message =
        err instanceof Error ? err.message : "Unexpected server error.";
      sendError(res, message, 500, "INTERNAL_ERROR");
    });
  };
}

/** Resolves frontend base URL without trailing slash. */
export function resolveAppBaseUrl(overrideUrl?: unknown): string {
  const candidate =
    typeof overrideUrl === "string" && overrideUrl.trim()
      ? overrideUrl
      : process.env.APP_BASE_URL || "http://localhost:5173";
  return candidate.trim().replace(/\/+$/, "");
}

/** Resolves the public HTTPS backend URL (explicit env, Render external URL, or reverse-proxy HTTPS host). */
export function resolvePublicBackendUrl(req: Request): string | undefined {
  const rawExplicit =
    process.env.BACKEND_PUBLIC_URL &&
    !process.env.BACKEND_PUBLIC_URL.includes("your-backend-service")
      ? process.env.BACKEND_PUBLIC_URL
      : process.env.RENDER_EXTERNAL_URL;

  const explicit = rawExplicit?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const host = req.get("host");
  if (!host) return undefined;
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  if (req.protocol === "https" && !isLocal) {
    return `https://${host}`;
  }
  return undefined;
}

