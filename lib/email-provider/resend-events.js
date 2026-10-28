import crypto from "node:crypto";
import { isObjectIdString, isPlainObject, normalizeAddress } from "../validation.js";

// Resend signs each delivery the Svix way: svix-signature holds "v1,<base64>" signatures, each an HMAC-SHA256 of
// "{svix-id}.{svix-timestamp}.{body}" keyed with the base64 after the secret's whsec_ prefix. Each retry is signed
// again, so an old timestamp is a replay.
export const MAX_SIGNATURE_AGE_SECONDS = 300;

function readSecret(secret) {
	const text = String(secret ?? "").trim();
	if (!text) return null;
	const key = Buffer.from(text.startsWith("whsec_") ? text.slice("whsec_".length) : text, "base64");
	return key.length > 0 ? key : null;
}

export function verifyResendSignature({ body, id, timestamp, signature, secret, now = Date.now() }) {
	const key = readSecret(secret);
	if (!key || typeof id !== "string" || !id || id.length > 200) return false;
	if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)) return false;
	if (typeof signature !== "string" || !signature) return false;
	if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
	const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
	return signature.split(" ").some((part) => {
		const [version, value] = part.split(",");
		if (version !== "v1" || !value) return false;
		const given = Buffer.from(value, "base64");
		return given.length === expected.length && crypto.timingSafeEqual(given, expected);
	});
}

// Opens and clicks come from MailCheap's own pixel and links (lib/tracking.js), and Resend's tracking is off on
// every domain MailCheap adds: its opened and clicked events, if any, would count them twice.
const EVENT_TYPES = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.delivery_delayed": "deferred",
	"email.bounced": "bounce",
	"email.complained": "complaint",
	"email.failed": "dropped",
	"email.suppressed": "dropped",
};

// Resend sends through SES and passes on its bounce words. NoEmail, or Suppressed (SES's list of addresses that
// bounced as invalid), say the address doesn't exist; General can be anything, a full mailbox included.
const UNDELIVERABLE_SUBTYPES = new Set(["NoEmail", "Suppressed"]);

function readText(value) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}

function readTag(tags, name) {
	if (!isPlainObject(tags) || !Object.hasOwn(tags, name)) return null;
	const value = tags[name];
	return isObjectIdString(value) ? value.toLowerCase() : null;
}

function toDate(value) {
	const date = typeof value === "string" ? new Date(value) : null;
	return date && Number.isFinite(date.getTime()) ? date : null;
}

function readDiagnostic(bounce) {
	const codes = Array.isArray(bounce.diagnosticCode) ? bounce.diagnosticCode : [bounce.diagnosticCode];
	return codes.map(readText).find(Boolean) ?? null;
}

// Pure: one Resend webhook event in the shape every provider's events take (lib/email-event-rules.js). The account and
// message come from the tags every send carries. eventId: the delivery's svix-id, the same on each retry.
export function normalizeResendEvent(raw, { eventId = null } = {}) {
	if (!isPlainObject(raw) || !Object.hasOwn(EVENT_TYPES, raw.type) || !isPlainObject(raw.data)) return null;
	const data = raw.data;
	const email = normalizeAddress(Array.isArray(data.to) ? data.to[0] : data.to);
	const normalized = {
		type: EVENT_TYPES[raw.type],
		recordAs: raw.type,
		accountId: readTag(data.tags, "account_id"),
		messageId: readTag(data.tags, "message_id"),
		providerMessageId: readText(data.email_id),
		providerEventId: readText(eventId),
		email,
		emails: email ? [email] : [],
		occurredAt: toDate(raw.created_at) ?? new Date(),
		data: raw,
	};

	if (raw.type === "email.bounced") {
		const bounce = isPlainObject(data.bounce) ? data.bounce : {};
		const type = readText(bounce.type) ?? "Undetermined";
		const subType = readText(bounce.subType) ?? "General";
		const isHard = type === "Permanent";
		const reason = [subType, readDiagnostic(bounce) ?? readText(bounce.message)].filter(Boolean).join(", ");
		Object.assign(normalized, {
			bounce: isHard ? "hard" : "soft",
			undeliverable: isHard && UNDELIVERABLE_SUBTYPES.has(subType),
			reason: reason || null,
			detail: `${type}/${subType}`,
		});
	}
	if (raw.type === "email.complained") normalized.detail = "abuse";
	if (raw.type === "email.delivery_delayed") {
		const delay = isPlainObject(data.delivery_delayed) ? data.delivery_delayed : {};
		normalized.reason = readText(delay.diagnosticCode) ?? readText(delay.message) ?? null;
	}
	if (raw.type === "email.failed") {
		const failed = isPlainObject(data.failed) ? data.failed : {};
		normalized.error = `Failed at Resend: ${readText(failed.reason) ?? "no reason given"}`;
		normalized.suppressed = false;
	}
	// The address is on Resend's own suppression list, from an earlier bounce or complaint.
	if (raw.type === "email.suppressed") {
		const suppressed = isPlainObject(data.suppressed) ? data.suppressed : {};
		normalized.error = `Suppressed by Resend: ${readText(suppressed.type) ?? readText(suppressed.message) ?? "on its suppression list"}`;
		normalized.suppressed = true;
	}
	return normalized;
}
