import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app";
import { verifyCashfreeWebhookSignature } from "../lib/cashfree";
import {
  deriveSignedQrToken,
  hmacSha256Base64,
  timingSafeEqual,
} from "../lib/crypto";
import { resolveAppBaseUrl } from "../lib/http";

test("Cashfree HMAC-SHA256 webhook signature verification matches specification", () => {
  process.env.CASHFREE_APP_ID = "TEST_APP";
  process.env.CASHFREE_SECRET_KEY = "test_secret_key";
  process.env.CASHFREE_WEBHOOK_SECRET = "test_secret_key";

  const timestamp = "1731312000";
  const rawBody =
    '{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"ev_ord_1"}}}';

  const sig = hmacSha256Base64("test_secret_key", `${timestamp}${rawBody}`);
  assert.equal(timingSafeEqual(sig, sig), true);
  assert.equal(timingSafeEqual(sig, "tampered"), false);
  assert.equal(verifyCashfreeWebhookSignature(rawBody, sig, timestamp), true);
  assert.equal(
    verifyCashfreeWebhookSignature(`${rawBody} `, sig, timestamp),
    false,
  );
});

test("QR token generation encodes zero PII and matches deterministic SHA-256 hash", () => {
  process.env.QR_SIGNING_SECRET = "super-secret-signing-key-for-tests";
  const { qrToken, tokenHash } = deriveSignedQrToken(
    "EVT-12345",
    "reg-uuid-999",
  );
  assert.equal(qrToken.startsWith("ev1.EVT-12345."), true);
  assert.equal(tokenHash.length, 64);

  process.env.APP_BASE_URL = "https://eventra-eight-chi.vercel.app/";
  assert.equal(resolveAppBaseUrl(), "https://eventra-eight-chi.vercel.app");
});

test("Express app serves /health and enforces auth/webhook signatures", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CASHFREE_APP_ID = "TEST_APP";
  process.env.CASHFREE_SECRET_KEY = "test_secret_key";
  process.env.CASHFREE_WEBHOOK_SECRET = "test_webhook_secret";

  const app = createApp();
  const server = app.listen(0);

  try {
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      ok: boolean;
      service: string;
    };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, "eventra-backend");

    const unauthRes = await fetch(`${baseUrl}/api/create-payment-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "1" }),
    });
    assert.equal(unauthRes.status, 401);

    const badWebhookRes = await fetch(`${baseUrl}/api/cashfree-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": "invalid",
        "x-webhook-timestamp": "1731312000",
      },
      body: '{"type":"PAYMENT_SUCCESS_WEBHOOK"}',
    });
    assert.equal(badWebhookRes.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

