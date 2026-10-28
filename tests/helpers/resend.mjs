import crypto from "node:crypto";

// An in-memory Resend behind a mocked fetch: POST /emails with Idempotency-Key and the domains API, as its API
// reference describes them. Its own URL, so MailCheap's own emails (api.resend.com) stay recorded apart.
export const RESEND = {
	apiUrl: "https://api.resend.test",
	apiKey: "re_test_provider_key",
	// whsec_ and the base64 of a made-up key.
	webhookSecret: `whsec_${Buffer.from("resend-webhook-secret-for-tests").toString("base64")}`,
};

export const RESEND_ENV = {
	EMAIL_PROVIDER: "resend",
	RESEND_API_KEY: RESEND.apiKey,
	RESEND_API_URL: RESEND.apiUrl,
	RESEND_WEBHOOK_SECRET: RESEND.webhookSecret,
};

// Svix's signature of one delivery, as Resend sends it.
export function signResend(body, { id = `msg_${crypto.randomUUID()}`, timestamp = Math.floor(Date.now() / 1000), secret = RESEND.webhookSecret } = {}) {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
	return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` };
}

function reply(status, body) {
	return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function header(headers, name) {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
	return key ? headers[key] : undefined;
}

function domainOf(address) {
	return (/<([^<>]+)>\s*$/.exec(address)?.[1] ?? address).split("@")[1]?.toLowerCase();
}

// Resend names records under the domain's zone; for a domain at its zone's apex, under the domain itself.
function recordsFor(name, status) {
	const sub = name.split(".").length > 2 ? `.${name.split(".")[0]}` : "";
	return [
		{ record: "DKIM", name: `resend._domainkey${sub}`, type: "TXT", ttl: "Auto", status, value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADtest" },
		{ record: "SPF", name: `send${sub}`, type: "MX", ttl: "Auto", status, value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
		{ record: "SPF", name: `send${sub}`, type: "TXT", ttl: "Auto", status, value: "v=spf1 include:amazonses.com ~all" },
	];
}

export function createFakeResend() {
	const state = { emails: [], domains: new Map(), calls: [], idempotency: new Map(), failures: [] };

	function readDomain(domain) {
		const status = domain.verified ? "verified" : domain.checked ? "pending" : "not_started";
		return { id: domain.id, name: domain.name, created_at: domain.createdAt.toISOString().replace("T", " "), status, region: "us-east-1", records: recordsFor(domain.name, status), open_tracking: domain.open_tracking, click_tracking: domain.click_tracking };
	}

	// A failure answers the next matching calls instead of the fake.
	function fail({ method = "POST", path, status, body, headers, times = 1 }) {
		state.failures.push({ method, path, status, body, headers, times });
	}

	function takeFailure(method, path) {
		const failure = state.failures.find((item) => item.method === method && item.path.test(path));
		if (!failure) return null;
		if (--failure.times <= 0) state.failures.splice(state.failures.indexOf(failure), 1);
		return new Response(JSON.stringify(failure.body), { status: failure.status, headers: { "content-type": "application/json", ...failure.headers } });
	}

	// A domain the team has from outside MailCheap: added by hand, or by an earlier attempt.
	function addTeamDomain(name, { verified = true, createdAt = new Date() } = {}) {
		const domain = { id: crypto.randomUUID(), name, createdAt, verified, checked: false };
		state.domains.set(domain.id, domain);
		return domain;
	}

	function verifyDomain(name) {
		for (const domain of state.domains.values()) if (domain.name === name) domain.verified = true;
	}

	function handle(url, init = {}) {
		const method = init.method ?? "GET";
		const path = new URL(url).pathname;
		const body = init.body ? JSON.parse(init.body) : undefined;
		const idempotencyKey = header(init.headers, "Idempotency-Key");
		state.calls.push({ method, path, body, idempotencyKey, authorization: header(init.headers, "Authorization") });
		if (header(init.headers, "Authorization") !== `Bearer ${RESEND.apiKey}`) return reply(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
		const failure = takeFailure(method, path);
		if (failure) return failure;

		if (method === "POST" && path === "/emails") {
			if (idempotencyKey && state.idempotency.has(idempotencyKey)) return reply(200, { id: state.idempotency.get(idempotencyKey) });
			const name = domainOf(body.from);
			const domain = [...state.domains.values()].find((item) => item.name === name);
			if (!domain?.verified) {
				return reply(403, { statusCode: 403, name: "validation_error", message: `The ${name} domain is not verified. Please, add and verify your domain on https://resend.com/domains` });
			}
			const id = crypto.randomUUID();
			state.emails.push({ id, body, idempotencyKey });
			if (idempotencyKey) state.idempotency.set(idempotencyKey, id);
			return reply(200, { id });
		}
		if (method === "POST" && path === "/domains") {
			if ([...state.domains.values()].some((item) => item.name === body.name)) {
				return reply(403, { statusCode: 403, name: "validation_error", message: "The domain is already registered" });
			}
			const domain = { id: crypto.randomUUID(), name: body.name, createdAt: new Date(), verified: false, checked: false, open_tracking: body.open_tracking, click_tracking: body.click_tracking };
			state.domains.set(domain.id, domain);
			return reply(200, readDomain(domain));
		}
		if (method === "GET" && path === "/domains") return reply(200, { object: "list", data: [...state.domains.values()].map(readDomain) });
		const match = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
		const domain = match && state.domains.get(decodeURIComponent(match[1]));
		if (match && !domain) return reply(404, { statusCode: 404, name: "not_found", message: "Domain not found" });
		if (match && method === "POST" && match[2]) {
			domain.checked = true;
			return reply(200, { object: "domain", id: domain.id });
		}
		if (match && method === "GET") return reply(200, readDomain(domain));
		if (match && method === "DELETE") {
			state.domains.delete(domain.id);
			return reply(200, { object: "domain", id: domain.id, deleted: true });
		}
		return reply(404, { statusCode: 404, name: "not_found", message: `No ${method} ${path}` });
	}

	// Answers Resend's provider URL and hands every other request to the fetch already installed.
	function install() {
		const previous = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			const url = String(input?.url ?? input);
			return url.startsWith(RESEND.apiUrl) ? handle(url, init) : previous(input, init);
		};
		return () => {
			globalThis.fetch = previous;
		};
	}

	function callsTo(method, pattern) {
		return state.calls.filter((call) => call.method === method && pattern.test(call.path));
	}

	return { state, fail, addTeamDomain, verifyDomain, install, callsTo };
}
