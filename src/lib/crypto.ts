import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Base64(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return nodeTimingSafeEqual(bufA, bufB);
}

export function generateTicketId(): string {
  const code = randomBytes(5).toString("hex").toUpperCase();
  return `EVT-${code}`;
}

function getQrSigningSecret(): string {
  const secret =
    process.env.QR_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("Missing QR_SIGNING_SECRET for ticket token signing.");
  }
  return secret;
}

/**
 * Generates an opaque, unguessable, PII-free QR token (`ev1.<ticketId>.<hmac>`).
 * Only the SHA-256 hash of this token is persisted in PostgreSQL.
 */
export function deriveSignedQrToken(
  ticketId: string,
  registrationId: string,
): { qrToken: string; tokenHash: string } {
  const secret = getQrSigningSecret();
  const signature = hmacSha256Hex(secret, `${ticketId}:${registrationId}`);
  const qrToken = `ev1.${ticketId}.${signature.slice(0, 32)}`;
  const tokenHash = sha256Hex(qrToken);
  return { qrToken, tokenHash };
}

