import "server-only";
import { isSendingEnabled } from "@/lib/config";
import { SEND_OUTCOMES, providerError } from "@/lib/email-provider/outcomes";
import { buildResendEmail, getResendSendError, getResendTags, toDomainStatus } from "@/lib/email-provider/resend-rules";
import { isRateLimited } from "@/lib/rate-limit";
import * as resend from "@/lib/resend";

// Under Resend's 10 requests a second for the whole team, which MailCheap's own emails share: RESEND_SEND_RATE_PER_SECOND
// once Resend raises it.
const DEFAULT_SEND_RATE = 8;
// Each check asks Resend to look at DNS again; between them, a read answers what it found last.
const VERIFY_LIMIT = { name: "resend-verify", limit: 6, window: "1 h" };
const CHECK_CACHE_MS = 60_000;

// Resend has no tenants: every account sends through MailCheap's one team, each email tagged with its account
// (getResendTags). MailCheap's own block is what holds an account, like on SES.
const TENANT = Object.freeze({ id: "resend" });

function getTenant(account) {
	return account ? TENANT : null;
}

async function provisionTenant() {
	return TENANT;
}

async function ensureTenant() {
	return TENANT;
}

async function suspendTenant() {}

async function resumeTenant() {
	return false;
}

function describeTenant() {
	return null;
}

async function removeTenant() {}

// Resend's default return path: bounces come back to send.<domain>, so SPF aligns with it.
const RETURN_PATH_PREFIX = "send";

function getMailFromDomain(domain) {
	return `${RETURN_PATH_PREFIX}.${domain}`;
}

// A name the team already has is a domain an earlier attempt added, if it's that recent and still unverified. Any
// other is the team's own (EMAIL_FROM's, another app's): an account adopting it would send as it, and removing it
// would delete it at Resend. One that another Resend team has is refused too.
const ADOPT_WITHIN_MS = 60 * 60_000;

export function isAdoptable(domain, now = Date.now()) {
	const createdAt = new Date(String(domain?.created_at ?? "").replace(" ", "T")).getTime();
	return domain?.status !== "verified" && Number.isFinite(createdAt) && now - createdAt < ADOPT_WITHIN_MS;
}

async function findOrCreateDomain(name) {
	try {
		return await resend.createDomain(name);
	} catch (error) {
		if (error.status !== 403 && error.status !== 409 && error.status !== 422) throw error;
		const domain = (await resend.listDomains()).find((item) => item.name === name);
		if (!domain || !isAdoptable(domain)) {
			throw Object.assign(new Error(`${name} can't be added: it's already set up at the email provider`), { isUserError: true, code: "conflict" });
		}
		return resend.getDomain(domain.id);
	}
}

async function addDomain({ domain }) {
	const created = await findOrCreateDomain(domain);
	return { providerDomainId: created.id, status: toDomainStatus(created) };
}

function isCheckedRecently(domain) {
	return domain.checkedAt && Date.now() - new Date(domain.checkedAt).getTime() < CHECK_CACHE_MS;
}

// verify asks Resend to check DNS now, within each account's share of checks. Resend checks on its own for 72 hours
// after a domain is added, so a read is enough in between.
async function readDomain({ account, domain, verify = false }) {
	if (!domain.providerDomainId) return { missing: true };
	if (verify && isCheckedRecently(domain)) return { unchanged: true };
	try {
		if (verify && !(await isRateLimited({ ...VERIFY_LIMIT, key: String(account._id) }))) await resend.verifyDomain(domain.providerDomainId);
		return toDomainStatus(await resend.getDomain(domain.providerDomainId));
	} catch (error) {
		if (error.status === 404) return { missing: true };
		return { error: error.message };
	}
}

async function removeDomain({ domain }) {
	if (!domain.providerDomainId) return;
	try {
		await resend.deleteDomain(domain.providerDomainId);
	} catch (error) {
		if (error.status !== 404) throw error;
	}
}

function getSendRate(env = process.env) {
	const rate = Number(env.RESEND_SEND_RATE_PER_SECOND);
	return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SEND_RATE;
}

// One rate for every kind of email: Resend's limit is per team, not per stream.
function getSendLane() {
	return { name: "resend", rate: getSendRate() };
}

// Idempotency-Key = the message id: a retry of the same email never sends it twice.
async function sendEmail({ message, email, feedbackId }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	const content = feedbackId ? { ...email, headers: { ...email.headers, "Feedback-ID": feedbackId } } : email;
	let result;
	try {
		result = await resend.sendEmail({ email: buildResendEmail({ email: content, tags: getResendTags(message) }), idempotencyKey: `mc-${message._id}` });
	} catch (error) {
		throw getResendSendError(error);
	}
	if (!result?.id) throw providerError(SEND_OUTCOMES.failed, "Resend didn't return the email's id");
	return { providerMessageId: result.id };
}

// MailCheap's own emails go through lib/platform-email.js with the same key; this is only its fallback's shape.
async function sendPlatformEmail(email) {
	await resend.sendEmail({ email: buildResendEmail({ email, tags: [{ name: "kind", value: "platform" }] }) });
}

function isConfigured() {
	try {
		resend.getResendConfig();
		return true;
	} catch {
		return false;
	}
}

export const resendProvider = Object.freeze({
	id: "resend",
	name: "Resend",
	returnPathPrefix: RETURN_PATH_PREFIX,
	isConfigured,
	sendPlatformEmail,
	getTenant,
	provisionTenant,
	ensureTenant,
	suspendTenant,
	resumeTenant,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	getSendRate,
	sendEmail,
});
