import { randomUUID } from "node:crypto";
import { Router } from "express";
import { createCashfreeOrder } from "../lib/cashfree";
import { deriveSignedQrToken, generateTicketId } from "../lib/crypto";
import { buildTicketEmailHtml, sendTransactionalEmail } from "../lib/email";
import {
  asyncHandler,
  resolveAppBaseUrl,
  resolvePublicBackendUrl,
  sendError,
} from "../lib/http";
import { requireAuthenticatedUser } from "../lib/supabaseAdmin";

export const registrationsRouter = Router();

registrationsRouter.post(
  "/register-free-event",
  asyncHandler(async (req, res) => {
    const { user, adminClient } = await requireAuthenticatedUser(req);
    const {
      eventId,
      participantName,
      participantEmail,
      participantPhone,
      collegeName,
      department,
      yearOfStudy,
    } = req.body ?? {};

    if (
      !eventId ||
      !participantName ||
      !participantEmail ||
      !participantPhone
    ) {
      return sendError(
        res,
        "Missing required registration fields (eventId, participantName, participantEmail, participantPhone).",
        400,
        "VALIDATION_ERROR",
      );
    }

    const registrationId = randomUUID();
    const ticketId = generateTicketId();
    const { tokenHash } = deriveSignedQrToken(ticketId, registrationId);

    const { data, error } = await adminClient.rpc("register_free_event_tx", {
      p_event_id: eventId,
      p_participant_id: user.id,
      p_participant_name: participantName,
      p_participant_email: participantEmail,
      p_participant_phone: participantPhone,
      p_college_name: collegeName || null,
      p_department: department || null,
      p_year_of_study: yearOfStudy || null,
      p_ticket_id: ticketId,
      p_token_hash: tokenHash,
      p_registration_id: registrationId,
    });

    if (error) {
      return sendError(res, error.message, 500, "DATABASE_ERROR");
    }

    if (!data?.ok) {
      return sendError(
        res,
        data?.message || "Registration failed.",
        409,
        data?.code || "CONFLICT",
      );
    }

    const appBaseUrl = resolveAppBaseUrl();
    // Dispatch confirmation email in background so the user navigates to their pass immediately
    void sendTransactionalEmail(adminClient, {
      to: participantEmail,
      subject: `Your Eventra Pass — ${data.event_title}`,
      eventType: "ticket_issued",
      registrationId: data.registration_id,
      html: buildTicketEmailHtml({
        participantName,
        eventTitle: data.event_title,
        ticketId: data.ticket_id,
        ticketUrl: `${appBaseUrl}/tickets/${data.ticket_id}`,
        amountLabel: "FREE (₹0)",
      }),
    }).catch(() => {});

    return res.json({
      ok: true,
      registrationId: data.registration_id,
      ticketId: data.ticket_id,
      eventTitle: data.event_title,
    });
  }),
);

registrationsRouter.post(
  "/create-payment-order",
  asyncHandler(async (req, res) => {
    const { user, adminClient } = await requireAuthenticatedUser(req);
    const {
      eventId,
      participantName,
      participantEmail,
      participantPhone,
      collegeName,
      department,
      yearOfStudy,
      returnBaseUrl,
    } = req.body ?? {};

    if (
      !eventId ||
      !participantName ||
      !participantEmail ||
      !participantPhone
    ) {
      return sendError(
        res,
        "Missing required participant details for checkout.",
        400,
        "VALIDATION_ERROR",
      );
    }

    // 1. Atomically reserve seat in PostgreSQL before contacting Cashfree
    const { data: reservation, error: resError } = await adminClient.rpc(
      "reserve_event_registration_tx",
      {
        p_event_id: eventId,
        p_participant_id: user.id,
        p_participant_name: participantName,
        p_participant_email: participantEmail,
        p_participant_phone: participantPhone,
        p_college_name: collegeName || null,
        p_department: department || null,
        p_year_of_study: yearOfStudy || null,
      },
    );

    if (resError) {
      return sendError(res, resError.message, 500, "DATABASE_ERROR");
    }

    if (!reservation?.ok) {
      return sendError(
        res,
        reservation?.message || "Unable to reserve seat.",
        409,
        reservation?.code || "RESERVATION_REJECTED",
        { existingRegistrationId: reservation?.existing_registration_id },
      );
    }

    const registrationId: string = reservation.registration_id;
    const orderId = `ev_ord_${registrationId.replace(/-/g, "").slice(0, 22)}`;
    const appBaseUrl = resolveAppBaseUrl(returnBaseUrl);
    const publicBackendUrl = resolvePublicBackendUrl(req);
    const notifyUrl = publicBackendUrl
      ? `${publicBackendUrl}/api/cashfree-webhook`
      : undefined;

    // 2. Create Cashfree Order via official Orders API
    try {
      const cfOrder = await createCashfreeOrder({
        orderId,
        amount: Number(reservation.payable_amount),
        currency: reservation.currency || "INR",
        customerId: user.id,
        customerName: participantName,
        customerEmail: participantEmail,
        customerPhone: participantPhone,
        returnUrl: `${appBaseUrl}/payment-status?order_id={order_id}&registration_id=${registrationId}`,
        notifyUrl,
        orderNote: `Eventra: ${reservation.event_title}`,
      });

      const { error: payError } = await adminClient.from("payments").insert({
        registration_id: registrationId,
        provider: "cashfree",
        provider_order_id: cfOrder.order_id,
        payment_session_id: cfOrder.payment_session_id,
        amount: Number(reservation.payable_amount),
        base_amount: Number(reservation.base_fee),
        gateway_fee: Number(reservation.gateway_fee),
        tax_amount: Number(reservation.tax_amount),
        currency: reservation.currency || "INR",
        status: "CREATED",
        provider_response_reference: cfOrder,
        status_history: [
          {
            from: null,
            to: "CREATED",
            cf_order_id: cfOrder.cf_order_id,
            at: new Date().toISOString(),
          },
        ],
      });

      if (payError) {
        throw new Error(`Failed to persist payment record: ${payError.message}`);
      }

      return res.json({
        ok: true,
        registrationId,
        orderId: cfOrder.order_id,
        paymentSessionId: cfOrder.payment_session_id,
        payableAmount: Number(reservation.payable_amount),
        baseFee: Number(reservation.base_fee),
        gatewayFee: Number(reservation.gateway_fee),
        taxAmount: Number(reservation.tax_amount),
        currency: reservation.currency || "INR",
        expiresAt: reservation.expires_at,
      });
    } catch (cfErr) {
      await adminClient
        .from("registrations")
        .update({ status: "expired", payment_status: "FAILED" })
        .eq("id", registrationId);

      return sendError(
        res,
        cfErr instanceof Error
          ? cfErr.message
          : "Failed to initialize Cashfree payment order.",
        502,
        "CASHFREE_ORDER_ERROR",
      );
    }
  }),
);

