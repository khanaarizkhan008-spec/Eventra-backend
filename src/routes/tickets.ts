import { Router } from "express";
import { deriveSignedQrToken, sha256Hex } from "../lib/crypto";
import { asyncHandler, sendError } from "../lib/http";
import { requireAuthenticatedUser } from "../lib/supabaseAdmin";

export const ticketsRouter = Router();

ticketsRouter.post(
  "/check-ticket",
  asyncHandler(async (req, res) => {
    const { user, profile, adminClient } = await requireAuthenticatedUser(req);
    const body = req.body ?? {};
    const action = body.action || "check_in";

    if (action === "get_qr") {
      const ticketId: string | undefined = body.ticketId;
      if (!ticketId) {
        return sendError(res, "Missing ticketId.", 400, "VALIDATION_ERROR");
      }

      const { data: ticket, error: ticketErr } = await adminClient
        .from("tickets")
        .select(
          "*, registrations!inner(status, payment_status), events!inner(organizer_id)",
        )
        .eq("id", ticketId)
        .single();

      if (ticketErr || !ticket) {
        return sendError(res, "Ticket not found.", 404, "TICKET_NOT_FOUND");
      }

      const isOwner = ticket.participant_id === user.id;
      const isEventOrganizer = ticket.events?.organizer_id === user.id;
      if (!isOwner && !isEventOrganizer && profile.role !== "admin") {
        return sendError(
          res,
          "Not authorized to access this ticket.",
          403,
          "FORBIDDEN",
        );
      }

      if (
        ticket.status === "refunded" ||
        ticket.status === "cancelled" ||
        ticket.registrations?.status !== "confirmed" ||
        !["FREE", "SUCCESS"].includes(ticket.registrations?.payment_status)
      ) {
        return sendError(
          res,
          "A valid QR pass is only issued for confirmed registrations.",
          403,
          "TICKET_INVALID_STATE",
        );
      }

      const { qrToken, tokenHash } = deriveSignedQrToken(
        ticket.id,
        ticket.registration_id,
      );

      if (tokenHash !== ticket.token_hash) {
        return sendError(
          res,
          "Ticket signature verification mismatch. Please contact support.",
          500,
          "TOKEN_MISMATCH",
        );
      }

      return res.json({ ok: true, ticketId: ticket.id, qrToken });
    }

    if (profile.role !== "organizer" && profile.role !== "admin") {
      return sendError(
        res,
        "Only organizers and administrators can validate admission tickets.",
        403,
        "FORBIDDEN",
      );
    }

    const qrToken: string | undefined = body.qrToken;
    const ticketId: string | undefined = body.ticketId;
    const eventId: string | undefined = body.eventId;
    const scannerReference: string = body.scannerReference || "web-scanner";

    if (!qrToken && !ticketId) {
      return sendError(
        res,
        "Provide either a scanned qrToken or a manual ticketId.",
        400,
        "VALIDATION_ERROR",
      );
    }

    const tokenHash = qrToken ? sha256Hex(qrToken.trim()) : null;

    const { data, error } = await adminClient.rpc("atomic_check_in_ticket_tx", {
      p_organizer_id: user.id,
      p_token_hash: tokenHash,
      p_ticket_id: ticketId ? ticketId.trim() : null,
      p_event_id: eventId || null,
      p_scanner_reference: scannerReference,
    });

    if (error) {
      return sendError(res, error.message, 500, "CHECK_IN_DB_ERROR");
    }

    return res.json(data);
  }),
);

