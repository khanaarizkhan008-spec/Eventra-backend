import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  createCashfreeRefund,
  getCashfreeOrder,
  getCashfreeOrderPayments,
} from "../lib/cashfree";
import { sendTransactionalEmail } from "../lib/email";
import { asyncHandler, sendError } from "../lib/http";
import { confirmVerifiedPaidOrder } from "../lib/paymentConfirmation";
import { requireAuthenticatedUser } from "../lib/supabaseAdmin";

export const paymentsRouter = Router();

paymentsRouter.post(
  "/verify-payment",
  asyncHandler(async (req, res) => {
    const { user, profile, adminClient } = await requireAuthenticatedUser(req);
    const orderId: string | undefined = req.body?.orderId;

    if (!orderId) {
      return sendError(res, "Missing orderId.", 400, "VALIDATION_ERROR");
    }

    const { data: paymentRow, error: payLookupErr } = await adminClient
      .from("payments")
      .select(
        "*, registrations!inner(id, participant_id, status, ticket_id, payable_amount, event_id)",
      )
      .eq("provider_order_id", orderId)
      .single();

    if (payLookupErr || !paymentRow) {
      return sendError(
        res,
        "Payment order record not found.",
        404,
        "ORDER_NOT_FOUND",
      );
    }

    const reg = paymentRow.registrations;
    if (reg.participant_id !== user.id && profile.role !== "admin") {
      return sendError(
        res,
        "Unauthorized to verify this payment order.",
        403,
        "FORBIDDEN",
      );
    }

    if (
      reg.status === "confirmed" &&
      paymentRow.status === "SUCCESS" &&
      reg.ticket_id
    ) {
      return res.json({
        ok: true,
        status: "SUCCESS",
        registrationStatus: "confirmed",
        orderId,
        registrationId: reg.id,
        ticketId: reg.ticket_id,
        amount: paymentRow.amount,
      });
    }

    const [cfOrder, cfPayments] = await Promise.all([
      getCashfreeOrder(orderId),
      getCashfreeOrderPayments(orderId),
    ]);

    const successfulPayment = cfPayments.find(
      (p) => p.payment_status === "SUCCESS",
    );
    const pendingPayment = cfPayments.find(
      (p) => p.payment_status === "PENDING",
    );
    const latestPayment = cfPayments[0];

    if (cfOrder.order_status === "PAID" && successfulPayment) {
      const { result: confirmResult, errorMessage } =
        await confirmVerifiedPaidOrder({
          adminClient,
          orderId,
          registrationId: reg.id,
          existingTicketId: reg.ticket_id ?? null,
          paymentAmount: paymentRow.amount,
          cfOrder,
          successfulPayment,
          providerResponsePayload: { order: cfOrder, payment: successfulPayment },
        });

      if (errorMessage) {
        return sendError(res, errorMessage, 500, "CONFIRMATION_ERROR");
      }

      if (!confirmResult?.ok) {
        return sendError(
          res,
          confirmResult?.message ||
            "Payment verification failed business validation.",
          409,
          confirmResult?.code || "VERIFICATION_FAILED",
        );
      }

      return res.json({
        ok: true,
        status: "SUCCESS",
        registrationStatus: "confirmed",
        orderId,
        registrationId: confirmResult.registration_id,
        ticketId: confirmResult.ticket_id,
        amount: paymentRow.amount,
      });
    }

    if (pendingPayment || cfOrder.order_status === "ACTIVE") {
      if (reg.status === "expired") {
        if (paymentRow.status !== "FAILED") {
          await adminClient
            .from("payments")
            .update({
              status: "FAILED",
              provider_payment_id: latestPayment
                ? String(latestPayment.cf_payment_id)
                : paymentRow.provider_payment_id,
              status_history: [
                ...(Array.isArray(paymentRow.status_history)
                  ? paymentRow.status_history
                  : []),
                {
                  from: paymentRow.status,
                  to: "FAILED",
                  reason: "Reservation hold expired before payment completion",
                  at: new Date().toISOString(),
                },
              ],
            })
            .eq("id", paymentRow.id);

          await adminClient
            .from("registrations")
            .update({ payment_status: "FAILED" })
            .eq("id", reg.id);
        }

        return res.json({
          ok: true,
          status: "FAILED",
          registrationStatus: "expired",
          orderId,
          registrationId: reg.id,
          cashfreeOrderStatus: cfOrder.order_status,
          cashfreePaymentStatus: latestPayment?.payment_status ?? null,
          message:
            "Seat reservation expired before Cashfree confirmed the payment. Please register again to start a fresh checkout.",
        });
      }

      if (pendingPayment && paymentRow.status === "CREATED") {
        await adminClient
          .from("payments")
          .update({
            status: "PENDING",
            provider_payment_id: String(pendingPayment.cf_payment_id),
            provider_response_reference: {
              order: cfOrder,
              payment: pendingPayment,
            },
            status_history: [
              ...(Array.isArray(paymentRow.status_history)
                ? paymentRow.status_history
                : []),
              {
                from: paymentRow.status,
                to: "PENDING",
                at: new Date().toISOString(),
              },
            ],
          })
          .eq("id", paymentRow.id);

        await adminClient
          .from("registrations")
          .update({ payment_status: "PENDING" })
          .eq("id", reg.id);
      }

      return res.json({
        ok: true,
        status: "PENDING",
        registrationStatus: reg.status,
        orderId,
        registrationId: reg.id,
        cashfreeOrderStatus: cfOrder.order_status,
        cashfreePaymentStatus: latestPayment?.payment_status ?? null,
        message: pendingPayment
          ? "Payment is still awaiting confirmation from Cashfree."
          : "Order is active and awaiting payment completion in Cashfree.",
      });
    }

    const failureMessage =
      latestPayment?.payment_message ||
      `Cashfree order status: ${cfOrder.order_status}`;

    if (paymentRow.status !== "FAILED") {
      await adminClient
        .from("payments")
        .update({
          status: "FAILED",
          provider_payment_id: latestPayment
            ? String(latestPayment.cf_payment_id)
            : null,
          provider_response_reference: { order: cfOrder, payments: cfPayments },
          status_history: [
            ...(Array.isArray(paymentRow.status_history)
              ? paymentRow.status_history
              : []),
            {
              from: paymentRow.status,
              to: "FAILED",
              reason: failureMessage,
              at: new Date().toISOString(),
            },
          ],
        })
        .eq("id", paymentRow.id);

      await adminClient
        .from("registrations")
        .update({
          payment_status: "FAILED",
          status: cfOrder.order_status === "EXPIRED" ? "expired" : reg.status,
        })
        .eq("id", reg.id);
    }

    return res.json({
      ok: true,
      status: "FAILED",
      registrationStatus: reg.status,
      orderId,
      registrationId: reg.id,
      message: failureMessage,
    });
  }),
);

paymentsRouter.post(
  "/initiate-refund",
  asyncHandler(async (req, res) => {
    const { user, profile, adminClient } = await requireAuthenticatedUser(req);
    const { paymentId, amount, reason } = req.body ?? {};

    if (!paymentId || !reason) {
      return sendError(
        res,
        "Missing paymentId or refund reason.",
        400,
        "VALIDATION_ERROR",
      );
    }

    const { data: paymentRow, error: payErr } = await adminClient
      .from("payments")
      .select(
        "*, registrations!inner(id, event_id, participant_email, participant_name, events!inner(id, title, organizer_id))",
      )
      .eq("id", paymentId)
      .single();

    if (payErr || !paymentRow) {
      return sendError(res, "Payment record not found.", 404, "PAYMENT_NOT_FOUND");
    }

    const event = paymentRow.registrations.events;
    const isAdmin = profile.role === "admin";
    const isOwnerOrganizer =
      profile.role === "organizer" &&
      profile.organizer_status === "approved" &&
      event.organizer_id === user.id;

    if (!isAdmin && !isOwnerOrganizer) {
      return sendError(
        res,
        "You are not authorized to initiate refunds for this payment.",
        403,
        "FORBIDDEN",
      );
    }

    const refundAmount = amount ? Number(amount) : Number(paymentRow.amount);
    if (
      Number.isNaN(refundAmount) ||
      refundAmount <= 0 ||
      refundAmount > Number(paymentRow.amount)
    ) {
      return sendError(res, "Invalid refund amount.", 400, "INVALID_REFUND_AMOUNT");
    }

    const providerRefundId = `ev_ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

    const cfRefund = await createCashfreeRefund({
      orderId: paymentRow.provider_order_id,
      refundId: providerRefundId,
      refundAmount,
      refundNote: reason,
    });

    const mappedStatus =
      cfRefund.refund_status === "SUCCESS" ? "SUCCESS" : "PENDING";

    const { data: applyResult, error: applyErr } = await adminClient.rpc(
      "apply_refund_tx",
      {
        p_payment_id: paymentId,
        p_provider_refund_id: providerRefundId,
        p_cf_refund_id: String(cfRefund.cf_refund_id),
        p_refund_amount: refundAmount,
        p_refund_status: mappedStatus,
        p_reason: reason,
        p_initiated_by: user.id,
      },
    );

    if (applyErr || !applyResult?.ok) {
      return sendError(
        res,
        applyErr?.message || applyResult?.message || "Failed to record refund.",
        409,
        "REFUND_DB_ERROR",
      );
    }

    await sendTransactionalEmail(adminClient, {
      to: paymentRow.registrations.participant_email,
      subject: `Refund Initiated — ${event.title}`,
      eventType: "refund_confirmed",
      registrationId: paymentRow.registration_id,
      html: `<p>Hi ${paymentRow.registrations.participant_name}, a refund of <strong>₹${refundAmount.toFixed(2)}</strong> for <strong>${event.title}</strong> (${reason}) has been processed (Ref: ${providerRefundId}).</p>`,
    });

    return res.json({
      ok: true,
      refundId: providerRefundId,
      cfRefundId: cfRefund.cf_refund_id,
      refundStatus: mappedStatus,
      paymentStatus: applyResult.payment_status,
      isFullRefund: applyResult.is_full_refund,
    });
  }),
);

