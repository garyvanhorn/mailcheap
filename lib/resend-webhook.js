import "server-only";
import { NextResponse } from "next/server";
import { sendAlertIfRepeated } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { handleEmailEvent } from "@/lib/email-events";
import { normalizeResendEvent, verifyResendSignature } from "@/lib/email-provider/resend-events";
import Account from "@/models/Account";

// Resend posts one event per request.
const MAX_BODY_BYTES = 512 * 1024;

function reply(status, body) {
	return NextResponse.json(body, { status });
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// The team may send other emails too (MailCheap's own, with no account tag): those aren't any account's. Resend has no
// tenant to check the tag against, so only MailCheap may send with an account_id tag on this team.
export async function handleResendEvent(raw, { eventId } = {}) {
	const event = normalizeResendEvent(raw, { eventId });
	if (!event) return { handled: false };
	await connectDb();
	const account = event.accountId ? await Account.findById(event.accountId).select({ _id: 1 }).lean() : null;
	if (!account) {
		if (event.type !== "sent" && event.type !== "delivered") console.warn(`[resend-webhook] ${event.recordAs} for no known account`);
		return { handled: true, accountId: null };
	}
	const result = await handleEmailEvent({ ...event, accountId: account._id }, { isAccountTrusted: true });
	// Resend gets a 200 either way, so a message that can't be matched would otherwise go unseen.
	if (result.handled && event.messageId && !result.messageId) {
		console.warn(`[resend-webhook] ${event.recordAs} for account ${account._id}: no message ${event.messageId} with Resend id ${event.providerMessageId ?? "none"}`);
	}
	return { ...result, accountId: String(account._id) };
}

// Delivery events of every account (/api/webhooks/resend). Checked against the raw bytes before parsing.
// A 5xx makes Resend retry (for about a day); every handler is safe to replay.
export async function handleResendRequest(request) {
	const secret = process.env.RESEND_WEBHOOK_SECRET;
	if (!secret) return reply(503, { error: "Webhook is not configured" });
	if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return reply(413, { error: "Body is too large" });
	const body = Buffer.from(await request.arrayBuffer());
	if (body.length > MAX_BODY_BYTES) return reply(413, { error: "Body is too large" });
	const eventId = request.headers.get("svix-id");
	const isSigned = verifyResendSignature({
		body,
		id: eventId,
		timestamp: request.headers.get("svix-timestamp"),
		signature: request.headers.get("svix-signature"),
		secret,
	});
	if (!isSigned) return reply(401, { error: "Invalid signature" });

	const event = parseJson(body.toString("utf8"));
	if (!event || typeof event !== "object" || Array.isArray(event)) return reply(400, { error: "Expected an event" });
	try {
		const { handled } = await handleResendEvent(event, { eventId });
		return reply(200, { ok: true, handled: handled ? 1 : 0 });
	} catch (error) {
		console.error("[resend-webhook] Could not handle the event:", error);
		await sendAlertIfRepeated("resend-webhook", {
			accountId: null,
			key: "webhook-failing:resend-webhook",
			title: "Webhook failing",
			detail: `resend-webhook couldn't handle 3 events within an hour: ${String(error?.message ?? error).slice(0, 300)}.`,
			action: "Resend retries each one for about a day; until then bounces and complaints go uncounted.",
			link: "https://resend.com/webhooks",
		});
		return reply(500, { error: "Could not handle the event" });
	}
}
