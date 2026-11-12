import { Router } from "express";
import { notifyCancelledEventRegistrants } from "../lib/email";
import { asyncHandler, sendError } from "../lib/http";
import {
  getSupabaseAdmin,
  requireAuthenticatedUser,
} from "../lib/supabaseAdmin";

export const adminRouter = Router();

adminRouter.post(
  "/admin-actions",
  asyncHandler(async (req, res) => {
    const { user, profile, adminClient } = await requireAuthenticatedUser(req);
    if (profile.role !== "admin") {
      return sendError(res, "Administrator access required.", 403, "FORBIDDEN");
    }

    const body = req.body ?? {};
    const { action } = body;

    switch (action) {
      case "approve_organizer": {
        const { targetUserId } = body;
        if (!targetUserId) return sendError(res, "Missing targetUserId.", 400);
        const { error } = await adminClient
          .from("profiles")
          .update({
            role: "organizer",
            organizer_status: "approved",
            is_suspended: false,
          })
          .eq("id", targetUserId);
        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      case "reject_organizer": {
        const { targetUserId } = body;
        if (!targetUserId) return sendError(res, "Missing targetUserId.", 400);
        const { error } = await adminClient
          .from("profiles")
          .update({ organizer_status: "rejected" })
          .eq("id", targetUserId);
        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      case "set_user_role": {
        const { targetUserId, role } = body;
        if (
          !targetUserId ||
          !["participant", "organizer", "admin"].includes(role)
        ) {
          return sendError(res, "Invalid user ID or role.", 400);
        }
        if (targetUserId === user.id && role !== "admin") {
          return sendError(
            res,
            "Administrators cannot demote themselves.",
            400,
          );
        }
        const updatePayload: Record<string, unknown> = { role };
        if (role === "organizer") updatePayload.organizer_status = "approved";
        const { error } = await adminClient
          .from("profiles")
          .update(updatePayload)
          .eq("id", targetUserId);
        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      case "toggle_suspend_user": {
        const { targetUserId, suspend } = body;
        if (!targetUserId || typeof suspend !== "boolean") {
          return sendError(res, "Invalid targetUserId or suspend boolean.", 400);
        }
        if (targetUserId === user.id) {
          return sendError(
            res,
            "Administrators cannot suspend themselves.",
            400,
          );
        }
        const updatePayload = suspend
          ? { is_suspended: true, organizer_status: "suspended" }
          : { is_suspended: false };
        const { error } = await adminClient
          .from("profiles")
          .update(updatePayload)
          .eq("id", targetUserId);
        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      case "moderate_event": {
        const { eventId, status, isFeatured } = body;
        if (!eventId) return sendError(res, "Missing eventId.", 400);

        const updates: Record<string, unknown> = {};
        if (status) updates.status = status;
        if (typeof isFeatured === "boolean") updates.is_featured = isFeatured;

        const { data: ev, error } = await adminClient
          .from("events")
          .update(updates)
          .eq("id", eventId)
          .select("id, title")
          .single();

        if (error) return sendError(res, error.message, 500);

        if (status === "cancelled" && ev) {
          await notifyCancelledEventRegistrants(
            adminClient,
            eventId,
            ev.title,
            (participantName) =>
              `<p>Hi ${participantName}, unfortunately <strong>${ev.title}</strong> has been cancelled by platform administration. Any eligible paid registrations will be refunded.</p>`,
          );
        }

        return res.json({ ok: true });
      }

      case "update_platform_settings": {
        const {
          passGatewayFeeToCustomer,
          gatewayFeePercentage,
          gstOnFeePercentage,
          reservationExpiryMinutes,
          requireEventApproval,
        } = body;

        const { error } = await adminClient
          .from("platform_settings")
          .update({
            pass_gateway_fee_to_customer: Boolean(passGatewayFeeToCustomer),
            gateway_fee_percentage: Number(gatewayFeePercentage),
            gst_on_fee_percentage: Number(gstOnFeePercentage),
            reservation_expiry_minutes: Number(reservationExpiryMinutes),
            require_event_approval: Boolean(requireEventApproval),
          })
          .eq("id", 1);

        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      case "resolve_report": {
        const { reportId, status } = body;
        if (
          !reportId ||
          !["reviewed", "resolved", "dismissed"].includes(status)
        ) {
          return sendError(res, "Invalid report update.", 400);
        }
        const { error } = await adminClient
          .from("event_reports")
          .update({ status, reviewed_by: user.id })
          .eq("id", reportId);
        if (error) return sendError(res, error.message, 500);
        return res.json({ ok: true });
      }

      default:
        return sendError(res, `Unsupported admin action: ${action}`, 400);
    }
  }),
);

adminRouter.post(
  "/expire-reservations",
  asyncHandler(async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = req.header("x-cron-secret");
    const adminClient = getSupabaseAdmin();

    let authorized = Boolean(cronSecret && providedSecret === cronSecret);

    if (!authorized) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const jwt = authHeader.slice("Bearer ".length).trim();
        const { data: userData } = await adminClient.auth.getUser(jwt);
        if (userData?.user) {
          const { data: prof } = await adminClient
            .from("profiles")
            .select("role")
            .eq("id", userData.user.id)
            .single();
          if (prof?.role === "admin") authorized = true;
        }
      }
    }

    if (!authorized) {
      return sendError(
        res,
        "Unauthorized reservation expiry trigger.",
        401,
        "UNAUTHORIZED",
      );
    }

    const { data: expiredCount, error } = await adminClient.rpc(
      "expire_unpaid_reservations_tx",
    );

    if (error) {
      return sendError(res, error.message, 500, "DATABASE_ERROR");
    }

    return res.json({
      ok: true,
      expiredCount: expiredCount ?? 0,
      executedAt: new Date().toISOString(),
    });
  }),
);

