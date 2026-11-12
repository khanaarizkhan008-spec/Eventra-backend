import type { SupabaseClient } from "@supabase/supabase-js";
import type { CashfreeOrderResponse, CashfreePaymentItem } from "./cashfree";
import { deriveSignedQrToken, generateTicketId } from "./crypto";
import { buildTicketEmailHtml, sendTransactionalEmail } from "./email";
import { resolveAppBaseUrl } from "./http";

export interface ConfirmPaidOrderParams {
  adminClient: SupabaseClient;
  orderId: string;
  registrationId: string;
  existingTicketId: string | null;
  paymentAmount: number | string;
  cfOrder: CashfreeOrderResponse;
  successfulPayment: CashfreePaymentItem;
  providerResponsePayload: Record<string, unknown>;
}

export interface ConfirmPaidOrderResult {
  ok: boolean;
  code?: string;
  message?: string;
  registration_id?: string;
  ticket_id?: string;
  idempotent?: boolean;
}

/**
 * Atomically confirms a Cashfree-verified paid order via Postgres RPC,
 * derives the signed QR ticket token, and dispatches confirmation email once.
 */
export async function confirmVerifiedPaidOrder(
  params: ConfirmPaidOrderParams,
): Promise<{ result: ConfirmPaidOrderResult | null; errorMessage?: string }> {
  const {
    adminClient,
    orderId,
    registrationId,
    existingTicketId,
    paymentAmount,
    cfOrder,
    successfulPayment,
    providerResponsePayload,
  } = params;

  const ticketId = existingTicketId || generateTicketId();
  const { tokenHash } = deriveSignedQrToken(ticketId, registrationId);
  const methodLabel =
    successfulPayment.payment_group ||
    (successfulPayment.payment_method
      ? Object.keys(successfulPayment.payment_method)[0]
      : "cashfree");

  const { data: confirmResult, error: confirmErr } = await adminClient.rpc(
    "confirm_paid_registration_tx",
    {
      p_provider_order_id: orderId,
      p_provider_payment_id: String(successfulPayment.cf_payment_id),
      p_verified_amount: Number(
        successfulPayment.payment_amount ?? cfOrder.order_amount,
      ),
      p_verified_currency:
        successfulPayment.payment_currency || cfOrder.order_currency,
      p_payment_method: methodLabel,
      p_ticket_id: ticketId,
      p_token_hash: tokenHash,
      p_provider_response: providerResponsePayload,
    },
  );

  if (confirmErr) {
    return { result: null, errorMessage: confirmErr.message };
  }

  if (confirmResult?.ok && !confirmResult.idempotent) {
    const appBaseUrl = resolveAppBaseUrl();
    await sendTransactionalEmail(adminClient, {
      to: confirmResult.participant_email,
      subject: `Payment Confirmed & Ticket Issued — ${confirmResult.event_title}`,
      eventType: "payment_confirmed",
      registrationId: confirmResult.registration_id,
      html: buildTicketEmailHtml({
        participantName: confirmResult.participant_name,
        eventTitle: confirmResult.event_title,
        ticketId: confirmResult.ticket_id,
        ticketUrl: `${appBaseUrl}/tickets/${confirmResult.ticket_id}`,
        amountLabel: `₹${Number(paymentAmount).toFixed(2)}`,
      }),
    });
  }

  return { result: confirmResult as ConfirmPaidOrderResult };
}

