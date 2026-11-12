import { Router } from "express";
import {
  notifyCancelledEventRegistrants,
  sendTransactionalEmail,
} from "../lib/email";
import { asyncHandler, resolveAppBaseUrl, sendError } from "../lib/http";
import { requireAuthenticatedUser } from "../lib/supabaseAdmin";

export const organizerRouter = Router();

organizerRouter.post(
  "/organizer-actions",
  asyncHandler(async (req, res) => {
    const { user, profile, adminClient } = await requireAuthenticatedUser(req);
    const body = req.body ?? {};
    const { action } = body;

    if (action === "request_organizer_access") {
      const { organizationName } = body;
      const { error } = await adminClient
        .from("profiles")
        .update({
          organizer_status: "pending",
          organization_name: organizationName || null,
        })
        .eq("id", user.id);

      if (error) return sendError(res, error.message, 500);
      return res.json({ ok: true, organizer_status: "pending" });
    }

    if (action === "cancel_event") {
      const { eventId } = body;
      if (!eventId) return sendError(res, "Missing eventId.", 400);

      const { data: eventRow, error: evErr } = await adminClient
        .from("events")
        .select("id, title, organizer_id, status")
        .eq("id", eventId)
        .single();

      if (evErr || !eventRow) return sendError(res, "Event not found.", 404);
      if (eventRow.organizer_id !== user.id && profile.role !== "admin") {
        return sendError(res, "Forbidden.", 403);
      }

      const { error: updErr } = await adminClient
        .from("events")
        .update({ status: "cancelled" })
        .eq("id", eventId);

      if (updErr) return sendError(res, updErr.message, 500);

      const notifiedCount = await notifyCancelledEventRegistrants(
        adminClient,
        eventId,
        eventRow.title,
        (participantName) =>
          `<p>Hi ${participantName}, <strong>${eventRow.title}</strong> has been cancelled by the organizer. If you made a paid booking, please contact the organizer or admin for refund settlement.</p>`,
      );

      return res.json({ ok: true, notifiedCount });
    }

    if (action === "send_event_reminders") {
      const { eventId } = body;
      if (!eventId) return sendError(res, "Missing eventId.", 400);

      const { data: eventRow, error: evErr } = await adminClient
        .from("events")
        .select("id, title, venue, start_at, organizer_id, status")
        .eq("id", eventId)
        .single();

      if (evErr || !eventRow) return sendError(res, "Event not found.", 404);
      if (eventRow.organizer_id !== user.id && profile.role !== "admin") {
        return sendError(res, "Forbidden.", 403);
      }

      const { data: regs } = await adminClient
        .from("registrations")
        .select("id, participant_email, participant_name, ticket_id")
        .eq("event_id", eventId)
        .eq("status", "confirmed");

      const appBaseUrl = resolveAppBaseUrl();
      if (regs?.length) {
        await Promise.allSettled(
          regs.map((r) =>
            sendTransactionalEmail(adminClient, {
              to: r.participant_email,
              subject: `Reminder: ${eventRow.title} is starting soon`,
              eventType: "event_reminder",
              registrationId: r.id,
              html: `<p>Hi ${r.participant_name}, reminder that <strong>${eventRow.title}</strong> takes place at <strong>${eventRow.venue}</strong> on ${new Date(eventRow.start_at).toLocaleString("en-IN")}. <a href="${appBaseUrl}/tickets/${r.ticket_id}">Open your QR ticket</a>.</p>`,
            }),
          ),
        );
      }

      return res.json({ ok: true, sentCount: regs?.length ?? 0 });
    }

    return sendError(res, `Unsupported organizer action: ${action}`, 400);
  }),
);

