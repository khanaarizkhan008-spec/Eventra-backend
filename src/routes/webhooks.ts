import type { Request, Response } from "express";
import {
  getCashfreeOrder,
  getCashfreeOrderPayments,
  getCashfreeRefund,
  verifyCashfreeWebhookSignature,
} from "../lib/cashfree";
import { sha256Hex } from "../lib/crypto";
import { sendTransactionalEmail } from "../lib/email";
import { sendError } from "../lib/http";
import { confirmVerifiedPaidOrder } from "../lib/paymentConfirmation";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

/**
 * Handles Cashfree server-to-server webhooks.
 * Must be mounted with `express.raw()` so exact unmodified request bytes are verified via HMAC-SHA256.
 */
export async function cashfreeWebhookHandler(
  req: Request,
  res: Response,
): Promise<Response> {
  let webhookRowId: string | null = null;
  const adminClient = getSupabaseAdmin();

  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : "";

    const signature = req.header("x-webhook-signature");
    const timestamp = req.header("x-webhook-timestamp");

    if (!verifyCashfreeWebhookSignature(rawBody, signature, timestamp)) {
      return sendError(
        res,
        "Invalid Cashfree webhook signature.",
        401,
        "INVALID_SIGNATURE",
      );
    }

    const payload = JSON.parse(rawBody) as {
      type?: string;
      data?: {
        order?: { order_id?: string };
        payment?: { cf_payment_id?: string | number; payment_status?: string };
        refund?: { refund_id?: string };
      };
    };

    const eventType: string = payload?.type || "UNKNOWN";
    const orderId: string | undefined = payload?.data?.order?.order_id;
    const cfPaymentId = payload?.data?.payment?.cf_payment_id
      ? String(payload.data.payment.cf_payment_id)
      : "";
    const rawDigest = sha256Hex(`${timestamp}:${rawBody}`);
    const providerEventId = `${eventType}:${orderId || "no_order"}:${cfPaymentId || rawDigest.slice(0, 16)}`;

    // 2. Idempotency guard via webhook_events unique constraint
    const { data: insertedEvent, error: webhookInsertErr } = await adminClient
      .from("webhook_events")
      .insert({
        provider: "cashfree",
        provider_event_id: providerEventId,
        event_type: eventType,
        payload_summary: {
          order_id: orderId,
          cf_payment_id: cfPaymentId,
          payment_status: payload?.data?.payment?.payment_status,
        },
        processing_status: "received",
      })
      .select("id")
      .single();

    if (webhookInsertErr) {
      if (webhookInsertErr.code === "23505") {
        return res.status(200).json({ ok: true, status: "ignored_duplicate" });
      }
      throw new Error(webhookInsertErr.message);
    }

    webhookRowId = insertedEvent?.id ?? null;

    if (!orderId) {
      await adminClient
        .from("webhook_events")
        .update({
          processing_status: "processed",
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookRowId);
      return res.status(200).json({ ok: true, status: "ignored_no_order_id" });
    }

    const [cfOrder, cfPayments] = await Promise.all([
      getCashfreeOrder(orderId),
      getCashfreeOrderPayments(orderId),
    ]);

    const { data: paymentRow } = await adminClient
      .from("payments")
      .select(
        "*, registrations!inner(id, participant_email, participant_name, status, ticket_id)",
      )
      .eq("provider_order_id", orderId)
      .single();

    if (!paymentRow) {
      await adminClient
        .from("webhook_events")
        .update({
          processing_status: "failed",
          error_message: `No payment record for order ${orderId}`,
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookRowId);
      return res
        .status(404)
        .json({ ok: false, error: "Order not registered in Eventra" });
    }

    const successfulPayment = cfPayments.find(
      (p) => p.payment_status === "SUCCESS",
    );

    if (cfOrder.order_status === "PAID" && successfulPayment) {
      const reg = paymentRow.registrations;
      const { result: confirmResult, errorMessage } =
        await confirmVerifiedPaidOrder({
          adminClient,
          orderId,
          registrationId: reg.id,
          existingTicketId: reg.ticket_id ?? null,
          paymentAmount: paymentRow.amount,
          cfOrder,
          successfulPayment,
          providerResponsePayload: {
            webhook_type: eventType,
            order: cfOrder,
            payment: successfulPayment,
          },
        });

      if (errorMessage || !confirmResult?.ok) {
        const failureReason = errorMessage || confirmResult?.message;
        await adminClient
          .from("webhook_events")
          .update({
            processing_status: "failed",
            error_message: failureReason,
            processed_at: new Date().toISOString(),
          })
          .eq("id", webhookRowId);
        return res.status(422).json({ ok: false, error: failureReason });
      }
    } else if (
      eventType === "PAYMENT_FAILED_WEBHOOK" ||
      eventType === "PAYMENT_USER_DROPPED_WEBHOOK"
    ) {
      if (paymentRow.status !== "SUCCESS") {
        await adminClient
          .from("payments")
          .update({
            status: "FAILED",
            provider_payment_id: cfPaymentId || paymentRow.provider_payment_id,
            provider_response_reference: { webhook: payload, order: cfOrder },
            status_history: [
              ...(Array.isArray(paymentRow.status_history)
                ? paymentRow.status_history
                : []),
              {
                from: paymentRow.status,
                to: "FAILED",
                reason: eventType,
                at: new Date().toISOString(),
              },
            ],
          })
          .eq("id", paymentRow.id);

        await adminClient
          .from("registrations")
          .update({ payment_status: "FAILED" })
          .eq("id", paymentRow.registration_id);

        await sendTransactionalEmail(adminClient, {
          to: paymentRow.registrations.participant_email,
          subject: "Eventra Payment Failed",
          eventType: "payment_failed",
          registrationId: paymentRow.registration_id,
          html: `<p>Hi ${paymentRow.registrations.participant_name}, your payment for order <strong>${orderId}</strong> did not succeed. No ticket was issued.</p>`,
        });
      }
    } else if (eventType === "REFUND_STATUS_WEBHOOK") {
      const refundId: string | undefined = payload?.data?.refund?.refund_id;
      if (refundId) {
        const cfRefund = await getCashfreeRefund(orderId, refundId);
        const mappedRefundStatus =
          cfRefund.refund_status === "SUCCESS"
            ? "SUCCESS"
            : cfRefund.refund_status === "CANCELLED"
              ? "CANCELLED"
              : "PENDING";

        await adminClient
          .from("refunds")
          .update({
            status: mappedRefundStatus,
            cf_refund_id: String(cfRefund.cf_refund_id),
          })
          .eq("provider_refund_id", refundId);

        if (mappedRefundStatus === "SUCCESS") {
          const { data: allRefunds } = await adminClient
            .from("refunds")
            .select("amount, status")
            .eq("payment_id", paymentRow.id)
            .eq("status", "SUCCESS");

          const totalRefunded = (allRefunds ?? []).reduce(
            (sum, r) => sum + Number(r.amount || 0),
            0,
          );
          const nextPaymentStatus =
            totalRefunded >= Number(paymentRow.amount)
              ? "REFUNDED"
              : "PARTIALLY_REFUNDED";

          await adminClient
            .from("payments")
            .update({ status: nextPaymentStatus })
            .eq("id", paymentRow.id);

          await adminClient
            .from("registrations")
            .update({
              payment_status: nextPaymentStatus,
              ...(nextPaymentStatus === "REFUNDED"
                ? { status: "refunded" }
                : {}),
            })
            .eq("id", paymentRow.registration_id);

          if (nextPaymentStatus === "REFUNDED") {
            await adminClient
              .from("tickets")
              .update({ status: "refunded" })
              .eq("registration_id", paymentRow.registration_id);
          }
        }
      }
    }

    await adminClient
      .from("webhook_events")
      .update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      })
      .eq("id", webhookRowId);

    return res.status(200).json({ ok: true, status: "processed" });
  } catch (err) {
    if (webhookRowId) {
      await adminClient
        .from("webhook_events")
        .update({
          processing_status: "failed",
          error_message:
            err instanceof Error ? err.message : "Webhook processing error",
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookRowId);
    }
    return sendError(
      res,
      err instanceof Error ? err.message : "Webhook handler failed.",
      500,
      "WEBHOOK_ERROR",
    );
  }
}

