import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationType =
  | "registration_confirmed"
  | "payment_confirmed"
  | "ticket_issued"
  | "payment_failed"
  | "refund_confirmed"
  | "event_cancelled"
  | "event_reminder";

export async function sendTransactionalEmail(
  adminClient: SupabaseClient,
  params: {
    to: string;
    subject: string;
    html: string;
    eventType: NotificationType;
    registrationId?: string;
  },
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Eventra <tickets@eventra.app>";

  if (!apiKey || apiKey.startsWith("re_your_")) {
    await adminClient.from("email_notifications").insert({
      recipient_email: params.to,
      event_type: params.eventType,
      registration_id: params.registrationId || null,
      status: "skipped_unconfigured",
      error_message: "RESEND_API_KEY not configured on backend server.",
    });
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
      }),
    });

    const data = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) {
      await adminClient.from("email_notifications").insert({
        recipient_email: params.to,
        event_type: params.eventType,
        registration_id: params.registrationId || null,
        status: "failed",
        error_message: data?.message || JSON.stringify(data),
      });
      return;
    }

    await adminClient.from("email_notifications").insert({
      recipient_email: params.to,
      event_type: params.eventType,
      registration_id: params.registrationId || null,
      status: "sent",
      provider_message_id: data?.id || null,
    });
  } catch (err) {
    await adminClient.from("email_notifications").insert({
      recipient_email: params.to,
      event_type: params.eventType,
      registration_id: params.registrationId || null,
      status: "failed",
      error_message: err instanceof Error ? err.message : "Unknown email error",
    });
  }
}

export function buildTicketEmailHtml(params: {
  participantName: string;
  eventTitle: string;
  ticketId: string;
  ticketUrl: string;
  amountLabel: string;
}): string {
  return `
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; background:#09090B; color:#FFFFFF; padding:32px; border-radius:16px;">
      <h2 style="margin:0 0 8px; color:#A78BFA;">Eventra Digital Pass</h2>
      <p style="margin:0 0 16px; color:#A1A1AA;">Hi ${params.participantName}, your registration for <strong style="color:#FFFFFF;">${params.eventTitle}</strong> is confirmed.</p>
      <div style="background:#141419; border:1px solid #27272A; padding:16px; border-radius:12px; margin-bottom:20px;">
        <div style="font-size:12px; color:#A1A1AA;">TICKET ID</div>
        <div style="font-family:monospace; font-size:18px; color:#FFFFFF; margin-top:4px;">${params.ticketId}</div>
        <div style="font-size:12px; color:#A1A1AA; margin-top:12px;">AMOUNT</div>
        <div style="font-size:15px; color:#FFFFFF; margin-top:4px;">${params.amountLabel}</div>
      </div>
      <a href="${params.ticketUrl}" style="display:inline-block; background:#8B5CF6; color:#FFFFFF; text-decoration:none; padding:12px 20px; border-radius:9999px; font-weight:600;">View QR Ticket</a>
    </div>
  `;
}

/** Sends event-cancelled notifications to all confirmed registrants of an event. */
export async function notifyCancelledEventRegistrants(
  adminClient: SupabaseClient,
  eventId: string,
  eventTitle: string,
  messageHtml: (participantName: string) => string,
): Promise<number> {
  const { data: regs } = await adminClient
    .from("registrations")
    .select("id, participant_email, participant_name")
    .eq("event_id", eventId)
    .eq("status", "confirmed");

  if (!regs?.length) return 0;

  await Promise.allSettled(
    regs.map((r) =>
      sendTransactionalEmail(adminClient, {
        to: r.participant_email,
        subject: `Event Cancelled — ${eventTitle}`,
        eventType: "event_cancelled",
        registrationId: r.id,
        html: messageHtml(r.participant_name),
      }),
    ),
  );

  return regs.length;
}

