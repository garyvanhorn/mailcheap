import { rootDomain } from "../root-domain.js";
import { SEND_OUTCOMES, providerError } from "./outcomes.js";

// Resend's domain and record statuses, in the SES words the Domains page already knows.
const STATUSES = {
	verified: "SUCCESS",
	not_started: "PENDING",
	pending: "PENDING",
	temporary_failure: "TEMPORARY_FAILURE",
	failed: "FAILED",
};

function toStatus(status) {
	return STATUSES[status] ?? "PENDING";
}

// Every record has to be found for the return path to work: its MX and its SPF TXT.
function combineStatuses(records) {
	const statuses = records.map(({ status }) => toStatus(status));
	if (statuses.length === 0) return "PENDING";
	if (statuses.includes("FAILED")) return "FAILED";
	if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
	return statuses.includes("TEMPORARY_FAILURE") ? "TEMPORARY_FAILURE" : "PENDING";
}

// Resend names records under the domain ("send", "resend._domainkey"), or under its zone for a subdomain ("send.mail"
// for mail.example.com). Stored as full host names, like SES's and PostShiba's.
export function getRecordHost(name, domain) {
	const host = String(name ?? "")
		.trim()
		.toLowerCase()
		.replace(/\.$/, "");
	if (!host || host === "@") return domain;
	if (host === domain || host.endsWith(`.${domain}`)) return host;
	const zone = rootDomain(domain);
	const sub = domain === zone ? "" : domain.slice(0, -zone.length - 1);
	if (sub && (host === sub || host.endsWith(`.${sub}`))) return `${host}.${zone}`;
	return `${host}.${domain}`;
}

function toRecord(record, domain, purpose) {
	const value = record.type === "MX" && record.priority != null ? `${record.priority} ${record.value}` : record.value;
	return { purpose, type: record.type, name: getRecordHost(record.name, domain), value };
}

// A Resend domain in the shape lib/domains.js stores: the DKIM key, and the return path's MX and SPF records. Its
// tracking and receiving records aren't MailCheap's.
export function toDomainStatus(domain) {
	const records = Array.isArray(domain?.records) ? domain.records : [];
	const dkim = records.filter(({ record }) => record === "DKIM");
	const returnPath = records.filter(({ record }) => record === "SPF");
	return {
		verified: domain?.status === "verified",
		dkimStatus: combineStatuses(dkim),
		mailFromStatus: combineStatuses(returnPath),
		records: [...dkim.map((record) => toRecord(record, domain.name, "dkim")), ...returnPath.map((record) => toRecord(record, domain.name, "mail-from"))].filter(
			({ name, value }) => name && value
		),
		lastError: null,
	};
}

// Tags come back on every webhook event. Names and values: ASCII letters, digits, _ and -, 256 at most.
export function getResendTags(message) {
	const tags = [
		{ name: "account_id", value: String(message.accountId) },
		{ name: "message_id", value: String(message._id) },
		{ name: "kind", value: String(message.kind).replace(/[^A-Za-z0-9_-]/g, "_") },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	return tags;
}

// POST /emails. Headers carry List-Unsubscribe, List-Unsubscribe-Post and Feedback-ID as MailCheap wrote them.
export function buildResendEmail({ email, tags }) {
	return {
		from: email.from,
		to: [email.to],
		subject: email.subject,
		html: email.html,
		// An empty text stays empty: Resend would write one from the HTML otherwise.
		text: email.text ?? "",
		...(email.replyTo && { reply_to: email.replyTo }),
		...(email.headers && Object.keys(email.headers).length > 0 && { headers: email.headers }),
		...(tags?.length && { tags }),
	};
}

// The free plan's daily quota frees up at midnight UTC.
export function getSecondsUntilMidnightUtc(now = new Date()) {
	const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	return Math.max(60, Math.ceil((midnight - now.getTime()) / 1000) + 60);
}

const KEY_PROBLEMS = new Set(["missing_api_key", "restricted_api_key", "suspended_api_key", "invalid_permission", "invalid_api_key"]);

const MESSAGES = {
	monthly_quota_exceeded: "Resend's monthly quota is used up: upgrade the Resend plan",
	daily_quota_exceeded: "Resend's daily quota is used up until midnight UTC",
};

// A 403 validation_error is a sending problem only Resend's words tell apart.
function getForbiddenOutcome(text) {
	if (/not verified|verify a domain|testing emails|own email address/i.test(text)) return SEND_OUTCOMES.domainUnverified;
	if (/api key/i.test(text)) return SEND_OUTCOMES.misconfigured;
	return SEND_OUTCOMES.failed;
}

// Every send carries an Idempotency-Key, so whatever didn't certainly fail can go again: a retry replays the
// first answer. A body that changed under the same key is refused, and never sent twice.
export function getResendSendError(error, now = new Date()) {
	const code = error?.providerCode ?? "";
	const text = `${code} ${error?.detail ?? ""} ${error?.message ?? ""}`;
	const make = (outcome, fields = {}) => providerError(outcome, MESSAGES[code] ?? error?.message ?? "Resend refused the email", { providerCode: code || null, ...fields });

	if (!error?.status) return make(SEND_OUTCOMES.unavailable);
	if (code === "monthly_quota_exceeded") return make(SEND_OUTCOMES.misconfigured);
	if (code === "daily_quota_exceeded") return make(SEND_OUTCOMES.throttled, { retryAfter: getSecondsUntilMidnightUtc(now) });
	if (error.status === 429) return make(SEND_OUTCOMES.throttled, { retryAfter: error.retryAfter ?? 1 });
	if (code === "concurrent_idempotent_requests" || code === "resource_locked") return make(SEND_OUTCOMES.throttled, { retryAfter: error.retryAfter ?? 5 });
	if (KEY_PROBLEMS.has(code) || error.status === 401) return make(SEND_OUTCOMES.misconfigured);
	if (error.status === 403) return make(getForbiddenOutcome(text));
	if (error.status >= 500) return make(SEND_OUTCOMES.unavailable);
	return make(SEND_OUTCOMES.failed);
}
