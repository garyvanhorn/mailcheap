import "server-only";

// Every call to Resend for customers' emails lives in this file, like lib/ses.js and lib/postshiba.js. MailCheap's own
// emails use the same key from lib/platform-email.js. Errors keep Resend's error name in providerCode.
const API_URL = "https://api.resend.com";
const TIMEOUT_MS = 10_000;
// A send waits for Resend to accept the message.
const SEND_TIMEOUT_MS = 20_000;

export function getResendConfig(env = process.env) {
	const apiKey = String(env.RESEND_API_KEY ?? "").trim();
	if (!apiKey) throw new Error("Resend is not configured (RESEND_API_KEY)");
	return {
		apiKey,
		apiUrl: (env.RESEND_API_URL || API_URL).trim().replace(/\/+$/, ""),
		// Where Resend sends a new domain's emails from. Domains added before a change stay in their region.
		region: String(env.RESEND_REGION ?? "").trim() || null,
	};
}

function readRetryAfter(headers) {
	const seconds = Number.parseInt(headers?.get("retry-after") ?? "", 10);
	return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

function resendError({ label, status = null, body = null, headers, cause }) {
	const providerCode = typeof body?.name === "string" ? body.name : null;
	const detail = typeof body?.message === "string" ? body.message.slice(0, 200) : typeof body === "string" ? body.slice(0, 200) : "";
	const answer = status ? `${status}${providerCode ? ` ${providerCode}` : ""}` : cause?.name === "TimeoutError" ? "timed out" : "no answer";
	return Object.assign(new Error(`Resend ${label}: ${answer}${detail ? ` (${detail})` : ""}`), {
		name: "ResendError",
		status,
		providerCode,
		detail,
		retryAfter: readRetryAfter(headers),
		isTimeout: cause?.name === "TimeoutError",
		cause,
	});
}

async function readBody(response) {
	if (response.status === 204) return null;
	const text = await response.text().catch(() => "");
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

async function call(path, { label, method = "GET", headers, body, timeoutMs = TIMEOUT_MS }) {
	const { apiKey, apiUrl } = getResendConfig();
	let response;
	try {
		response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				...(body !== undefined && { "Content-Type": "application/json" }),
				...headers,
			},
			...(body !== undefined && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		throw resendError({ label, cause });
	}
	const data = await readBody(response);
	if (!response.ok) throw resendError({ label, status: response.status, body: data, headers: response.headers });
	return data;
}

// Idempotency-Key: Resend answers a repeat within 24 hours with the first email, without sending it again.
export function sendEmail({ email, idempotencyKey }) {
	return call("/emails", {
		label: "send",
		method: "POST",
		body: email,
		headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
		timeoutMs: SEND_TIMEOUT_MS,
	});
}

// MailCheap counts its own opens and clicks (lib/tracking.js): Resend's would rewrite its links and count them twice.
export function createDomain(name) {
	const { region } = getResendConfig();
	return call("/domains", {
		label: "domain",
		method: "POST",
		body: { name, ...(region && { region }), open_tracking: false, click_tracking: false },
	});
}

export function getDomain(id) {
	return call(`/domains/${encodeURIComponent(id)}`, { label: "domain" });
}

export async function listDomains() {
	const result = await call("/domains", { label: "domains" });
	return Array.isArray(result?.data) ? result.data : [];
}

export function verifyDomain(id) {
	return call(`/domains/${encodeURIComponent(id)}/verify`, { label: "domain check", method: "POST" });
}

export function deleteDomain(id) {
	return call(`/domains/${encodeURIComponent(id)}`, { label: "domain removal", method: "DELETE" });
}
