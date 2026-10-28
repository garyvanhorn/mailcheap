import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { getEmailProviderId } from "../lib/config.js";
import { getEventPlan } from "../lib/email-event-rules.js";
import { SEND_OUTCOMES } from "../lib/email-provider/outcomes.js";
import { normalizeResendEvent, verifyResendSignature } from "../lib/email-provider/resend-events.js";
import { buildResendEmail, getRecordHost, getResendSendError, getResendTags, toDomainStatus } from "../lib/email-provider/resend-rules.js";
import { getSendErrorAction } from "../lib/sending-rules.js";
import { activate, as, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./helpers/app.mjs";
import { RESEND, RESEND_ENV, createFakeResend, signResend } from "./helpers/resend.mjs";
import { published } from "./stubs/qstash.mjs";

const ACCOUNT_ID = "64f1a2b3c4d5e6f7a8b9c0d1";
const MESSAGE_ID = "74f1a2b3c4d5e6f7a8b9c0d2";

function resendEvent(type, data = {}) {
	return {
		type,
		created_at: "2026-10-28T12:00:00.000Z",
		data: {
			created_at: "2026-10-28T11:59:58.000Z",
			email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
			from: "Jane <hello@letters.example.com>",
			to: ["Reader@Example.org"],
			subject: "Weekly",
			tags: { account_id: ACCOUNT_ID, message_id: MESSAGE_ID, kind: "campaign" },
			...data,
		},
	};
}

test("Resend is the provider only when EMAIL_PROVIDER names it: its key alone is MailCheap's own emails", () => {
	assert.equal(getEmailProviderId({ EMAIL_PROVIDER: "resend" }), "resend");
	assert.equal(getEmailProviderId({ EMAIL_PROVIDER: " Resend " }), "resend");
	assert.equal(getEmailProviderId({ RESEND_API_KEY: "re_key" }), "ses");
	assert.equal(getEmailProviderId({ RESEND_API_KEY: "re_key", POSTSHIBA_API_KEY: "ps_key" }), "postshiba");
	assert.equal(getEmailProviderId({ EMAIL_PROVIDER: "ses", RESEND_API_KEY: "re_key" }), "ses", "SES stays one switch away");
});

test("a signature is Svix's: v1 and the base64 HMAC of the id, the timestamp and the exact body, at most 5 minutes old", () => {
	const body = JSON.stringify(resendEvent("email.delivered"));
	const now = Date.now();
	const headers = signResend(body);
	const check = (fields = {}) =>
		verifyResendSignature({ body, id: headers["svix-id"], timestamp: headers["svix-timestamp"], signature: headers["svix-signature"], secret: RESEND.webhookSecret, now, ...fields });
	assert.equal(check(), true);
	assert.equal(check({ body: Buffer.from(body) }), true, "raw bytes too");
	assert.equal(check({ signature: `v1,bm9wZQ== ${headers["svix-signature"]}` }), true, "one of several signatures, as during a secret's rotation");

	assert.equal(check({ secret: `whsec_${Buffer.from("another-secret").toString("base64")}` }), false, "bad secret");
	assert.equal(check({ body: body.replace("delivered", "bounced") }), false, "changed body");
	assert.equal(check({ id: "msg_other" }), false, "the id is signed");
	assert.equal(check({ timestamp: String(Number(headers["svix-timestamp"]) + 1) }), false, "the timestamp is signed");
	assert.equal(check({ signature: headers["svix-signature"].replace("v1,", "v2,") }), false, "only v1");
	assert.equal(check({ signature: headers["svix-signature"].slice(3) }), false, "no version");
	assert.equal(check({ secret: "" }), false, "no secret, no trust");
	assert.equal(check({ id: null }), false);
	assert.equal(check({ timestamp: null }), false);

	const stale = signResend(body, { timestamp: Math.floor(now / 1000) - 301 });
	assert.equal(check({ id: stale["svix-id"], timestamp: stale["svix-timestamp"], signature: stale["svix-signature"] }), false, "stale");
	const future = signResend(body, { timestamp: Math.floor(now / 1000) + 301 });
	assert.equal(check({ id: future["svix-id"], timestamp: future["svix-timestamp"], signature: future["svix-signature"] }), false, "from the future");
});

test("Resend's events take the one event shape, with the account and message from the email's tags", () => {
	const delivered = normalizeResendEvent(resendEvent("email.delivered"), { eventId: "msg_1" });
	assert.equal(delivered.type, "delivered");
	assert.equal(delivered.recordAs, "email.delivered");
	assert.equal(delivered.accountId, ACCOUNT_ID);
	assert.equal(delivered.messageId, MESSAGE_ID);
	assert.equal(delivered.providerMessageId, "56761188-7520-42d8-8898-ff6fc54ce618");
	assert.equal(delivered.providerEventId, "msg_1", "the delivery's svix-id: a retry is recorded once");
	assert.equal(delivered.email, "reader@example.org");
	assert.deepEqual(delivered.occurredAt, new Date("2026-10-28T12:00:00.000Z"));
	assert.deepEqual(getEventPlan(delivered).status, { to: "delivered", from: ["queued", "sent", "failed"] });
	assert.equal(normalizeResendEvent(resendEvent("email.sent")).type, "sent");

	const hard = getEventPlan(
		normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "NoEmail", message: "The address doesn't exist", diagnosticCode: ["smtp; 550 5.1.1 user unknown"] } }))
	);
	assert.equal(hard.error, "Hard bounce: NoEmail, smtp; 550 5.1.1 user unknown");
	assert.deepEqual(hard.status, { to: "bounced", from: ["queued", "sent", "failed", "delivered"] });
	assert.deepEqual(hard.suppression, {
		emails: ["reader@example.org"],
		reason: "bounce",
		detail: "Permanent/NoEmail",
		contactStatus: "bounced",
		contactStatusFrom: ["active", "dormant", "unsubscribed"],
	});
	assert.deepEqual(hard.globalSuppression, { emails: ["reader@example.org"], reason: "bounce", detail: "Permanent/NoEmail" }, "an address that doesn't exist, for every account");

	const general = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "Mailbox full" } })));
	assert.equal(general.suppression.reason, "bounce", "a hard bounce suppresses in the account");
	assert.equal(general.globalSuppression, null, "General can be anything: not for every account");
	const suppressedBounce = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "Suppressed" } })));
	assert.equal(suppressedBounce.globalSuppression.reason, "bounce", "SES's own list of invalid addresses");

	const soft = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Transient", subType: "MailboxFull", message: "Mailbox full" } })));
	assert.deepEqual([soft.suppression, soft.status, soft.error], [null, null, "Soft bounce: MailboxFull, Mailbox full"]);
	const undetermined = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", {})));
	assert.equal(undetermined.suppression, null, "no bounce details: not the address's fault for sure");

	const complaint = getEventPlan(normalizeResendEvent(resendEvent("email.complained")));
	assert.deepEqual([complaint.suppression.reason, complaint.suppression.detail, complaint.status.to], ["complaint", "abuse", "complained"]);
	assert.deepEqual(complaint.suppression.contactStatusFrom, ["active", "dormant", "unsubscribed", "bounced"]);

	const delayed = getEventPlan(normalizeResendEvent(resendEvent("email.delivery_delayed")));
	assert.deepEqual([delayed.type, delayed.status, delayed.isRecorded], ["email.delivery_delayed", null, true]);

	const failed = getEventPlan(normalizeResendEvent(resendEvent("email.failed", { failed: { reason: "reached_daily_quota" } })));
	assert.deepEqual(failed.status, { to: "failed", from: ["queued", "sent"], stat: "failed" });
	assert.equal(failed.error, "Failed at Resend: reached_daily_quota");
	assert.equal(failed.suppression, null, "a failure isn't the address's");

	const suppressed = getEventPlan(normalizeResendEvent(resendEvent("email.suppressed", { suppressed: { type: "OnAccountSuppressionList", message: "On the suppression list" } })));
	assert.equal(suppressed.error, "Suppressed by Resend: OnAccountSuppressionList");
	assert.deepEqual(suppressed.suppression, { emails: ["reader@example.org"], reason: "provider", detail: "Suppressed by Resend: OnAccountSuppressionList", contactStatus: null });

	// MailCheap counts its own opens and clicks; Resend's would count them twice.
	for (const value of [null, [], "email.bounced", resendEvent("email.opened"), resendEvent("email.clicked"), resendEvent("email.received"), resendEvent("constructor"), { type: "email.delivered" }]) {
		assert.equal(normalizeResendEvent(value), null, JSON.stringify(value));
	}
	const spoofed = normalizeResendEvent(resendEvent("email.bounced", { tags: { account_id: { $ne: null }, message_id: "../x" } }));
	assert.deepEqual([spoofed.accountId, spoofed.messageId], [null, null]);
	assert.deepEqual([normalizeResendEvent(resendEvent("email.bounced", { tags: undefined })).accountId], [null], "MailCheap's own emails carry no account");
});

test("Resend's errors become outcomes: retry what didn't go, pause what the setup refuses, fail the rest", () => {
	const now = new Date("2026-10-28T23:00:00Z");
	const error = (status, name, message = "", fields = {}) => ({ status, providerCode: name, detail: message, message: `Resend send: ${status} ${name} (${message})`, ...fields });
	const outcome = (...args) => getResendSendError(error(...args), now);

	assert.equal(getResendSendError({ status: null, message: "Resend send: no answer" }).outcome, SEND_OUTCOMES.unavailable, "no answer: the Idempotency-Key makes a retry safe");
	assert.equal(getResendSendError({ status: null, isTimeout: true, message: "timed out" }).outcome, SEND_OUTCOMES.unavailable);

	const limited = outcome(429, "rate_limit_exceeded", "Too many requests", { retryAfter: 2 });
	assert.deepEqual([limited.outcome, limited.retryAfter], [SEND_OUTCOMES.throttled, 2]);
	assert.equal(outcome(429, "rate_limit_exceeded").retryAfter, 1);
	const daily = outcome(429, "daily_quota_exceeded");
	assert.deepEqual([daily.outcome, daily.retryAfter], [SEND_OUTCOMES.throttled, 3660], "after midnight UTC");
	const monthly = outcome(429, "monthly_quota_exceeded");
	assert.deepEqual([monthly.outcome, monthly.message], [SEND_OUTCOMES.misconfigured, "Resend's monthly quota is used up: upgrade the Resend plan"]);
	assert.equal(outcome(409, "concurrent_idempotent_requests").outcome, SEND_OUTCOMES.throttled);

	for (const [status, name, message] of [
		[401, "missing_api_key", "Missing API key"],
		[401, "validation_error", "API key is invalid"],
		[401, "restricted_api_key", "This API key is restricted to only send emails"],
		[403, "suspended_api_key", "This API key is suspended"],
	]) {
		assert.equal(outcome(status, name, message).outcome, SEND_OUTCOMES.misconfigured, name);
	}
	assert.equal(outcome(403, "validation_error", "The example.com domain is not verified. Please, add and verify your domain").outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(outcome(403, "validation_error", "You can only send testing emails to your own email address").outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(outcome(409, "invalid_idempotent_request").outcome, SEND_OUTCOMES.failed, "never sent twice with a changed body");
	assert.equal(outcome(422, "invalid_parameter").outcome, SEND_OUTCOMES.failed);
	assert.equal(outcome(400, "validation_error", "Invalid `to` field").outcome, SEND_OUTCOMES.failed);
	assert.equal(outcome(500, "application_error").outcome, SEND_OUTCOMES.unavailable);
	assert.equal(outcome(503, "service_unavailable").outcome, SEND_OUTCOMES.unavailable);

	assert.equal(getSendErrorAction(limited), "retry");
	assert.equal(getSendErrorAction(outcome(403, "validation_error", "domain is not verified")), "pause");
	assert.equal(getSendErrorAction(monthly), "pause");
	assert.equal(getSendErrorAction(outcome(422, "invalid_parameter")), "fail");
});

test("a Resend domain's records are full host names, for a domain or a subdomain of its zone", () => {
	assert.equal(getRecordHost("send", "example.com"), "send.example.com");
	assert.equal(getRecordHost("resend._domainkey", "mail.example.com"), "resend._domainkey.mail.example.com");
	assert.equal(getRecordHost("send.mail", "mail.example.com"), "send.mail.example.com", "named under the zone");
	assert.equal(getRecordHost("resend._domainkey.mail", "mail.example.com"), "resend._domainkey.mail.example.com");
	assert.equal(getRecordHost("send.mail.example.com.", "mail.example.com"), "send.mail.example.com", "already full");
	assert.equal(getRecordHost("send.mail", "mail.example.co.uk"), "send.mail.example.co.uk");

	const status = toDomainStatus({
		name: "mail.example.com",
		status: "pending",
		records: [
			{ record: "DKIM", name: "resend._domainkey.mail", type: "TXT", status: "verified", value: "p=KEY" },
			{ record: "SPF", name: "send.mail", type: "MX", status: "verified", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
			{ record: "SPF", name: "send.mail", type: "TXT", status: "pending", value: "v=spf1 include:amazonses.com ~all" },
			{ record: "Tracking", name: "links.mail", type: "CNAME", status: "not_started", value: "links1.resend-dns.com" },
			{ record: "Receiving", name: "mail", type: "MX", status: "not_started", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
		],
	});
	assert.deepEqual(status, {
		verified: false,
		dkimStatus: "SUCCESS",
		mailFromStatus: "PENDING",
		records: [
			{ purpose: "dkim", type: "TXT", name: "resend._domainkey.mail.example.com", value: "p=KEY" },
			{ purpose: "mail-from", type: "MX", name: "send.mail.example.com", value: "10 feedback-smtp.us-east-1.amazonses.com" },
			{ purpose: "mail-from", type: "TXT", name: "send.mail.example.com", value: "v=spf1 include:amazonses.com ~all" },
		],
		lastError: null,
	});
	const failed = toDomainStatus({ name: "example.com", status: "failed", records: [{ record: "SPF", name: "send", type: "MX", status: "failed", value: "x" }] });
	assert.deepEqual([failed.verified, failed.mailFromStatus, failed.dkimStatus], [false, "FAILED", "PENDING"]);
	assert.equal(toDomainStatus({ name: "example.com", status: "verified", records: [] }).verified, true);
});

test("an email for Resend keeps MailCheap's headers and tags as they are", () => {
	const message = { _id: MESSAGE_ID, accountId: ACCOUNT_ID, campaignId: "84f1a2b3c4d5e6f7a8b9c0d3", kind: "last-chance" };
	assert.deepEqual(getResendTags(message), [
		{ name: "account_id", value: ACCOUNT_ID },
		{ name: "message_id", value: MESSAGE_ID },
		{ name: "kind", value: "last-chance" },
		{ name: "campaign_id", value: "84f1a2b3c4d5e6f7a8b9c0d3" },
	]);
	const headers = { "List-Unsubscribe": "<https://app.example.com/api/unsubscribe?token=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
	const email = buildResendEmail({
		email: { from: "Jane <hello@example.com>", to: "reader@example.org", subject: "Hi", html: "<p>Hi</p>", text: "Hi", replyTo: "jane@example.com", headers },
		tags: getResendTags(message),
	});
	assert.deepEqual(email, {
		from: "Jane <hello@example.com>",
		to: ["reader@example.org"],
		subject: "Hi",
		html: "<p>Hi</p>",
		text: "Hi",
		reply_to: "jane@example.com",
		headers,
		tags: getResendTags(message),
	});
	assert.equal(buildResendEmail({ email: { from: "a@example.com", to: "b@example.org", subject: "x", html: "<p>x</p>" } }).text, "", "Resend never writes a text of its own");
});

describe("Resend as the email provider", () => {
	let app;
	let fake;
	let m;
	let processed = 0;

	async function runJobs() {
		while (processed < published.length) {
			const { url, body } = published[processed++];
			if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
		}
	}

	async function customer(email, slug) {
		const user = await signIn(email);
		await activate(user);
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, fromName: "Jane", postalAddress: "1 Main St, Paris" }))));
		user.newsletterId = url.split("/").at(-1);
		user.slug = slug;
		const domain = `${slug}.dev`;
		assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain }))), { ok: true, domain });
		fake.verifyDomain(domain);
		const stored = await m.Domain.findOne({ accountId: user.accountId, domain }).lean();
		await m.Domain.updateOne({ accountId: user.accountId, _id: stored._id }, { $unset: { checkedAt: 1 } });
		assert.deepEqual(await as(user, () => m.domains.checkDomainAction(String(stored._id))), { ok: true, verified: true });
		const saved = await as(user, () =>
			m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: slug, slug, fromName: "Jane", fromEmail: `hello@${domain}`, postalAddress: "1 Main St, Paris" }))
		);
		assert.equal(saved.ok, true);
		return user;
	}

	async function importContacts(user, emails) {
		await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows: emails.map((email) => ({ email, status: "active" })) }));
	}

	async function draft(user, subject) {
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const id = url.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello {{ name }}</p>" }));
		return id;
	}

	function postWebhook(event, { headers, body = JSON.stringify(event), id } = {}) {
		return m.webhookRoute.POST(
			new Request("http://localhost:3000/api/webhooks/resend", {
				method: "POST",
				headers: headers ?? { "content-type": "application/json", ...signResend(body, id ? { id } : {}) },
				body,
			})
		);
	}

	before(async () => {
		app = await startTestApp({ ...RESEND_ENV, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
		fake = createFakeResend();
		fake.install();
		processed = published.length;
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			contacts: await import("../app/(app)/contacts/actions.js"),
			domains: await import("../app/(app)/domains/actions.js"),
			sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
			webhookRoute: await import("../app/api/webhooks/resend/route.js"),
			providers: await import("../lib/email-provider/index.js"),
			capacity: await import("../lib/sending-capacity.js"),
			Campaign: (await import("../models/Campaign.js")).default,
			Contact: (await import("../models/Contact.js")).default,
			Domain: (await import("../models/Domain.js")).default,
			Event: (await import("../models/Event.js")).default,
			Message: (await import("../models/Message.js")).default,
			Suppression: (await import("../models/Suppression.js")).default,
		};
	});

	afterEach(() => fake.state.failures.splice(0));

	after(() => app?.stop());

	test("a domain gets Resend's DKIM and return path records with tracking off, and goes when it's removed", async () => {
		const user = await signIn("re-domain@example.com");
		await activate(user);
		assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain: "mail.letters.dev" }))), { ok: true, domain: "mail.letters.dev" });
		const domain = await m.Domain.findOne({ accountId: user.accountId }).lean();
		assert.equal(domain.provider, "resend");
		assert.equal(domain.mailFromDomain, "send.mail.letters.dev");
		const atResend = fake.state.domains.get(domain.providerDomainId);
		assert.deepEqual([atResend.name, atResend.open_tracking, atResend.click_tracking], ["mail.letters.dev", false, false], "MailCheap counts opens and clicks itself");
		assert.deepEqual(
			domain.records.map(({ purpose, type, name }) => `${purpose} ${type} ${name}`),
			["dkim TXT resend._domainkey.mail.letters.dev", "mail-from MX send.mail.letters.dev", "mail-from TXT send.mail.letters.dev"]
		);
		assert.equal(domain.verified, false);
		assert.equal(fake.callsTo("POST", /\/verify$/).length, 0, "Resend checks a new domain on its own");

		fake.verifyDomain("mail.letters.dev");
		await m.Domain.updateOne({ accountId: user.accountId, _id: domain._id }, { $unset: { checkedAt: 1 } });
		assert.deepEqual(await as(user, () => m.domains.checkDomainAction(String(domain._id))), { ok: true, verified: true });
		assert.equal(fake.callsTo("POST", new RegExp(`/domains/${domain.providerDomainId}/verify$`)).length, 1);
		const checked = await m.Domain.findOne({ accountId: user.accountId, _id: domain._id }).lean();
		assert.deepEqual([checked.dkimStatus, checked.mailFromStatus], ["SUCCESS", "SUCCESS"]);

		const other = await signIn("re-domain-other@example.com");
		await activate(other);
		assert.match((await as(other, () => m.domains.addDomainAction(null, form({ domain: "mail.letters.dev" })))).error, /used by another MailCheap account/);

		assert.deepEqual(await as(user, () => m.domains.removeDomainAction(String(domain._id))), { ok: true, removed: "mail.letters.dev" });
		assert.equal(fake.state.domains.has(domain.providerDomainId), false);
	});

	test("a domain the Resend team already has is never taken over, unless an earlier attempt just added it", async () => {
		const user = await signIn("re-takeover@example.com");
		await activate(user);
		const teams = fake.addTeamDomain("signin.example.com");
		const refused = await as(user, () => m.domains.addDomainAction(null, form({ domain: "signin.example.com" })));
		assert.match(refused.error, /already set up at the email provider/);
		assert.equal(await m.Domain.exists({ domain: "signin.example.com" }).setOptions({ crossAccount: true }), null, "the claim goes");
		assert.equal(fake.state.domains.has(teams.id), true, "the team's domain stays at Resend");

		fake.addTeamDomain("old.example.com", { verified: false, createdAt: new Date(Date.now() - 2 * 60 * 60_000) });
		assert.match((await as(user, () => m.domains.addDomainAction(null, form({ domain: "old.example.com" })))).error, /already set up/, "unverified, but not this attempt's");

		const lost = fake.addTeamDomain("retry.example.com", { verified: false });
		assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain: "retry.example.com" }))), { ok: true, domain: "retry.example.com" });
		assert.equal((await m.Domain.findOne({ accountId: user.accountId, domain: "retry.example.com" }).lean()).providerDomainId, lost.id, "an attempt whose answer was lost");
	});

	test("a campaign goes out through Resend with one-click unsubscribe, its tags and the message id as Idempotency-Key", async () => {
		const user = await customer("re-campaign@example.com", "re-campaign");
		await importContacts(user, ["one@example.org", "two@example.org", "gone@example.org"]);
		await m.Suppression.create({ accountId: user.accountId, email: "gone@example.org", reason: "bounce" });
		const id = await draft(user, "Weekly");
		const before = fake.state.emails.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();

		const emails = fake.state.emails.slice(before);
		assert.deepEqual(emails.map(({ body }) => body.to[0]).sort(), ["one@example.org", "two@example.org"], "the account's suppression list still applies");
		for (const { id: resendId, body, idempotencyKey } of emails) {
			assert.equal(body.from.endsWith("<hello@re-campaign.dev>"), true);
			assert.match(body.headers["List-Unsubscribe"], /^<https?:\/\/[^>]+\/api\/unsubscribe\?token=[^>]+>$/);
			assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
			assert.ok(body.headers["Feedback-ID"]);
			const tags = Object.fromEntries(body.tags.map(({ name, value }) => [name, value]));
			assert.deepEqual([tags.account_id, tags.campaign_id, tags.kind], [String(user.accountId), id, "campaign"]);
			assert.equal(idempotencyKey, `mc-${tags.message_id}`);
			const message = await m.Message.findOne({ accountId: user.accountId, _id: tags.message_id }).lean();
			assert.deepEqual([message.status, message.providerMessageId], ["sent", resendId], "matched by Resend's id from then on");
		}
		assert.equal(await m.Message.exists({ accountId: user.accountId, campaignId: id, email: "gone@example.org" }), null, "never queued");
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "sent");
	});

	test("Resend's rate limit puts the batch back with nothing lost, and the retry never sends an email twice", async () => {
		const user = await customer("re-limit@example.com", "re-limit");
		await importContacts(user, ["limit1@example.org", "limit2@example.org"]);
		const id = await draft(user, "Limited");
		fake.fail({ path: /^\/emails$/, status: 429, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }, headers: { "retry-after": "1" } });
		await as(user, () => m.campaigns.sendCampaign(id, {}));
		await runJobs();
		const emails = fake.state.emails.filter(({ body }) => body.to[0].startsWith("limit"));
		assert.deepEqual(emails.map(({ body }) => body.to[0]).sort(), ["limit1@example.org", "limit2@example.org"], "each once");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "sent" }), 2);
	});

	test("a from domain Resend doesn't take pauses the campaign with the reason", async () => {
		const user = await customer("re-unverified@example.com", "re-unverified");
		await importContacts(user, ["wait@example.org"]);
		const id = await draft(user, "Waiting");
		fake.fail({ path: /^\/emails$/, status: 403, body: { statusCode: 403, name: "validation_error", message: "The re-unverified.dev domain is not verified" } });
		await as(user, () => m.campaigns.sendCampaign(id, {}));
		await runJobs();
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.equal(campaign.status, "paused");
		assert.match(campaign.pauseReason, /not verified/);
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "queued" }), 1, "waits for the resume");
	});

	test("the webhook reads only signed, fresh events, and needs its secret", async () => {
		const event = resendEvent("email.delivered");
		assert.equal((await postWebhook(event, { headers: { "content-type": "application/json" } })).status, 401, "unsigned");
		const body = JSON.stringify(event);
		const forged = signResend(body, { secret: `whsec_${Buffer.from("forged").toString("base64")}` });
		assert.equal((await postWebhook(event, { headers: { "content-type": "application/json", ...forged } })).status, 401, "forged");
		const stale = signResend(body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
		assert.equal((await postWebhook(event, { headers: { "content-type": "application/json", ...stale } })).status, 401, "stale");
		assert.equal((await postWebhook([event])).status, 400, "one event per request");

		const secret = process.env.RESEND_WEBHOOK_SECRET;
		delete process.env.RESEND_WEBHOOK_SECRET;
		try {
			assert.equal((await postWebhook(event)).status, 503);
		} finally {
			process.env.RESEND_WEBHOOK_SECRET = secret;
		}
	});

	test("a hard bounce and a complaint land in their account only, once each, and Resend's suppressions are kept", async () => {
		const alice = await customer("re-alice@example.com", "re-alice");
		const bob = await customer("re-bob@example.com", "re-bob");
		await importContacts(bob, ["shared@example.org"]);
		const campaignId = new mongoose.Types.ObjectId();
		await m.Campaign.create({ _id: campaignId, accountId: alice.accountId, newsletterId: alice.newsletterId, subject: "Bounces", status: "sent", startedAt: new Date() });
		const sentTo = async (email, user = alice) => {
			const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active" });
			return m.Message.create({
				kind: "campaign",
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				campaignId,
				contactId: contact._id,
				email,
				status: "sent",
				sentAt: new Date(),
				providerMessageId: crypto.randomUUID(),
			});
		};
		const eventFor = (type, message, data = {}) =>
			resendEvent(type, { email_id: message.providerMessageId, to: [message.email], tags: { account_id: String(alice.accountId), message_id: String(message._id), kind: "campaign" }, ...data });

		const bounced = await sentTo("shared@example.org");
		const bounce = eventFor("email.bounced", bounced, { bounce: { type: "Permanent", subType: "General", message: "550 5.1.1 unknown user" } });
		assert.equal((await postWebhook(bounce, { id: "msg_bounce" })).status, 200);
		assert.equal((await postWebhook(bounce, { id: "msg_bounce" })).status, 200, "redelivered");
		assert.equal((await m.Message.findOne({ accountId: alice.accountId, _id: bounced._id }).lean()).status, "bounced");
		assert.equal((await m.Contact.findOne({ accountId: alice.accountId, email: "shared@example.org" }).lean()).status, "bounced");
		assert.ok(await m.Suppression.exists({ accountId: alice.accountId, email: "shared@example.org", reason: "bounce" }));
		assert.equal(await m.Event.countDocuments({ accountId: alice.accountId, providerEventId: "msg_bounce" }), 1, "recorded once");
		assert.equal((await m.Contact.findOne({ accountId: bob.accountId, email: "shared@example.org" }).lean()).status, "active", "Bob's contact with the same address stays");
		assert.equal(await m.Suppression.countDocuments({ accountId: bob.accountId }), 0);

		const complained = await sentTo("spam@example.org");
		assert.equal((await postWebhook(eventFor("email.complained", complained))).status, 200);
		assert.equal((await m.Contact.findOne({ accountId: alice.accountId, email: "spam@example.org" }).lean()).status, "complained");
		assert.ok(await m.Suppression.exists({ accountId: alice.accountId, email: "spam@example.org", reason: "complaint" }));

		const listed = await sentTo("listed@example.org");
		assert.equal((await postWebhook(eventFor("email.suppressed", listed, { suppressed: { type: "OnAccountSuppressionList" } }))).status, 200);
		assert.equal((await m.Message.findOne({ accountId: alice.accountId, _id: listed._id }).lean()).status, "failed");
		assert.ok(await m.Suppression.exists({ accountId: alice.accountId, email: "listed@example.org", reason: "provider" }), "kept out of the account's next sends");

		// Bob's id in Alice's tags: the message isn't in Alice's account, so Bob's stays as it is.
		const bobMessage = await sentTo("bob-only@example.org", bob);
		const crossed = resendEvent("email.complained", { email_id: bobMessage.providerMessageId, to: [bobMessage.email], tags: { account_id: String(alice.accountId), message_id: String(bobMessage._id) } });
		assert.equal((await postWebhook(crossed)).status, 200);
		assert.equal((await m.Message.findOne({ accountId: bob.accountId, _id: bobMessage._id }).lean()).status, "sent");
		assert.equal(await m.Suppression.countDocuments({ accountId: bob.accountId }), 0);

		const untagged = resendEvent("email.bounced", { tags: {}, bounce: { type: "Permanent", subType: "General" } });
		assert.deepEqual(await (await postWebhook(untagged)).json(), { ok: true, handled: 1 }, "MailCheap's own emails: no account");
		const unknown = resendEvent("email.bounced", { tags: { account_id: String(new mongoose.Types.ObjectId()) } });
		assert.equal((await postWebhook(unknown)).status, 200);
	});

	test("the admin page shows Resend's rate, without its quotas", async () => {
		assert.equal(m.providers.getEmailProvider().name, "Resend");
		assert.deepEqual(m.providers.getEmailProvider().getSendLane("campaign"), { name: "resend", rate: 8 });
		const capacity = await m.capacity.getSendingCapacity();
		assert.deepEqual(capacity, { lanes: [{ label: "All emails", status: null, meters: [], perSecond: 8 }] });
	});
});
