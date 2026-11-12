import { hmacSha256Base64, timingSafeEqual } from "./crypto";

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  webhookSecret: string;
  env: "sandbox" | "production";
  apiVersion: string;
  baseUrl: string;
}

export function getCashfreeConfig(): CashfreeConfig {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const env =
    (process.env.CASHFREE_ENV || "sandbox").toLowerCase() === "production"
      ? "production"
      : "sandbox";
  const apiVersion = process.env.CASHFREE_API_VERSION || "2025-01-01";
  const rawWebhookSecret = process.env.CASHFREE_WEBHOOK_SECRET;
  const webhookSecret =
    rawWebhookSecret && !rawWebhookSecret.startsWith("your-")
      ? rawWebhookSecret
      : secretKey || "";

  if (!appId || !secretKey) {
    throw new Error(
      "Cashfree credentials are not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY).",
    );
  }

  return {
    appId,
    secretKey,
    webhookSecret,
    env,
    apiVersion,
    baseUrl:
      env === "production"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg",
  };
}

function buildHeaders(cfg: CashfreeConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-client-id": cfg.appId,
    "x-client-secret": cfg.secretKey,
    "x-api-version": cfg.apiVersion,
  };
}

export interface CreateOrderParams {
  orderId: string;
  amount: number;
  currency: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  returnUrl: string;
  notifyUrl?: string;
  orderNote?: string;
}

export interface CashfreeOrderResponse {
  cf_order_id: string;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED";
  payment_session_id: string;
}

export interface CashfreePaymentItem {
  cf_payment_id: string | number;
  order_id: string;
  payment_status:
    | "SUCCESS"
    | "PENDING"
    | "FAILED"
    | "USER_DROPPED"
    | "NOT_ATTEMPTED"
    | string;
  payment_amount: number;
  payment_currency: string;
  payment_group?: string;
  payment_method?: Record<string, unknown>;
  payment_message?: string;
  payment_time?: string;
}

export async function createCashfreeOrder(
  params: CreateOrderParams,
): Promise<CashfreeOrderResponse> {
  const cfg = getCashfreeConfig();
  const sanitizedPhone =
    params.customerPhone.replace(/\D/g, "").slice(-10) || "9999999999";

  const payload = {
    order_id: params.orderId,
    order_amount: Number(params.amount.toFixed(2)),
    order_currency: params.currency.toUpperCase(),
    customer_details: {
      customer_id: params.customerId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48),
      customer_name: params.customerName.slice(0, 96),
      customer_email: params.customerEmail,
      customer_phone: sanitizedPhone,
    },
    order_meta: {
      return_url: params.returnUrl,
      ...(params.notifyUrl ? { notify_url: params.notifyUrl } : {}),
    },
    order_note: params.orderNote || "Eventra Event Registration",
  };

  const res = await fetch(`${cfg.baseUrl}/orders`, {
    method: "POST",
    headers: buildHeaders(cfg),
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Cashfree create order failed (${res.status}): ${
        (data?.message as string) || JSON.stringify(data)
      }`,
    );
  }
  return data as unknown as CashfreeOrderResponse;
}

export async function getCashfreeOrder(
  orderId: string,
): Promise<CashfreeOrderResponse> {
  const cfg = getCashfreeConfig();
  const res = await fetch(`${cfg.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: buildHeaders(cfg),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Cashfree fetch order failed (${res.status}): ${
        (data?.message as string) || JSON.stringify(data)
      }`,
    );
  }
  return data as unknown as CashfreeOrderResponse;
}

export async function getCashfreeOrderPayments(
  orderId: string,
): Promise<CashfreePaymentItem[]> {
  const cfg = getCashfreeConfig();
  const res = await fetch(
    `${cfg.baseUrl}/orders/${encodeURIComponent(orderId)}/payments`,
    {
      method: "GET",
      headers: buildHeaders(cfg),
    },
  );
  const data = (await res.json()) as unknown;
  if (!res.ok) {
    const errObj = data as Record<string, unknown>;
    throw new Error(
      `Cashfree fetch payments failed (${res.status}): ${
        (errObj?.message as string) || JSON.stringify(data)
      }`,
    );
  }
  return Array.isArray(data) ? (data as CashfreePaymentItem[]) : [];
}

export async function createCashfreeRefund(params: {
  orderId: string;
  refundId: string;
  refundAmount: number;
  refundNote: string;
}): Promise<{
  cf_refund_id: string;
  refund_id: string;
  refund_status: "PENDING" | "SUCCESS" | "CANCELLED" | "ONHOLD";
  refund_amount: number;
}> {
  const cfg = getCashfreeConfig();
  const res = await fetch(
    `${cfg.baseUrl}/orders/${encodeURIComponent(params.orderId)}/refunds`,
    {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        refund_id: params.refundId,
        refund_amount: Number(params.refundAmount.toFixed(2)),
        refund_note: params.refundNote.slice(0, 240),
        refund_speed: "STANDARD",
      }),
    },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Cashfree refund failed (${res.status}): ${
        (data?.message as string) || JSON.stringify(data)
      }`,
    );
  }
  return data as {
    cf_refund_id: string;
    refund_id: string;
    refund_status: "PENDING" | "SUCCESS" | "CANCELLED" | "ONHOLD";
    refund_amount: number;
  };
}

export async function getCashfreeRefund(
  orderId: string,
  refundId: string,
): Promise<{
  cf_refund_id: string;
  refund_id: string;
  refund_status: "PENDING" | "SUCCESS" | "CANCELLED" | "ONHOLD";
  refund_amount: number;
}> {
  const cfg = getCashfreeConfig();
  const res = await fetch(
    `${cfg.baseUrl}/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
    {
      method: "GET",
      headers: buildHeaders(cfg),
    },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Cashfree fetch refund failed (${res.status}): ${
        (data?.message as string) || JSON.stringify(data)
      }`,
    );
  }
  return data as {
    cf_refund_id: string;
    refund_id: string;
    refund_status: "PENDING" | "SUCCESS" | "CANCELLED" | "ONHOLD";
    refund_amount: number;
  };
}

/**
 * Cryptographically verifies Cashfree webhook signature:
 * computed = Base64(HMAC_SHA256(secret, timestamp + rawBody))
 */
export function verifyCashfreeWebhookSignature(
  rawBody: string,
  signature: string | undefined | null,
  timestamp: string | undefined | null,
): boolean {
  if (!signature || !timestamp || !rawBody) return false;
  const cfg = getCashfreeConfig();
  const signedPayload = `${timestamp}${rawBody}`;

  const computedWebhookSecret = hmacSha256Base64(cfg.webhookSecret, signedPayload);
  if (timingSafeEqual(computedWebhookSecret, signature)) {
    return true;
  }

  // Fallback check against client secret if separate webhook secret differs
  if (cfg.webhookSecret !== cfg.secretKey) {
    const computedSecretKey = hmacSha256Base64(cfg.secretKey, signedPayload);
    if (timingSafeEqual(computedSecretKey, signature)) {
      return true;
    }
  }

  return false;
}

