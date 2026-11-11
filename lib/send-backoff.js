import "server-only";
import { scoped } from "@/lib/account-scope";
import { sendAlert } from "@/lib/alerts";
import { BACKOFF, GMAIL_DELAYS, SENDER_WARMUP, WARMUP, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { isGmailDelayPileUp } from "@/lib/email-event-rules";
import { formatCount, formatNumber } from "@/lib/format";
import { GMAIL_DOMAINS } from "@/lib/providers";
import { getSendingDomain } from "@/lib/sender-rules";
import { findDomainNewsletterIds } from "@/lib/sender-warmup";
import { CAMPAIGN_MESSAGE_KINDS } from "@/lib/sending-rules";
import { pauseRateLimitedSends } from "@/lib/sending";
import Event from "@/models/Event";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import SenderDomain from "@/models/SenderDomain";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const RATE_LIMIT_REASON = `Gmail asked to slow down, so this newsletter's sends wait ${BACKOFF.hours} hours, then go on by themselves, more slowly at first`;

// The domain's back-off, started now unless one already runs: BACKOFF.hours to wait, then a warm-up from half the
// emails the account's newsletters sent from it in the day before.
async function claimBackoff(account, domain, newsletterIds, now) {
	const sentLastDay = await Message.countDocuments(
		scoped(account, { newsletterId: { $in: newsletterIds }, kind: { $in: CAMPAIGN_MESSAGE_KINDS }, sentAt: { $gte: new Date(now.getTime() - DAY_MS) } })
	);
	const resumeAt = new Date(now.getTime() + BACKOFF.hours * HOUR_MS);
	const firstDay = Math.max(WARMUP.quickEmails, Math.ceil(sentLastDay / 2));
	try {
		// A domain sending since before domains were kept has none yet.
		await SenderDomain.updateOne(
			scoped(account, { domain }),
			{ $setOnInsert: { startedAt: now, firstDay: SENDER_WARMUP.firstDay } },
			{ upsert: true }
		);
	} catch (error) {
		if (error?.code !== 11000) throw error;
	}
	const { modifiedCount } = await SenderDomain.updateOne(
		scoped(account, { domain, $or: [{ backoffAt: null }, { backoffAt: { $lte: new Date(now.getTime() - BACKOFF.hours * HOUR_MS) } }] }),
		{ $set: { startedAt: resumeAt, firstDay, backoffAt: now } }
	);
	if (modifiedCount) return { isNew: true, resumeAt, firstDay };
	const running = await SenderDomain.findOne(scoped(account, { domain })).lean();
	return { isNew: false, resumeAt: running.startedAt, firstDay: running.firstDay };
}

// Gmail rate limiting the domain a newsletter sent from (lib/email-event-rules.js): sending on would only tell it
// nobody listens. So the sends of every newsletter of the account sending from that domain pause, and BACKOFF.hours
// later the domain warms up again from half the emails it sent in the day before, doubling each day
// (lib/send-spread.js getSenderPace). Gmail saying it again in those hours, about emails still in the provider's queue,
// only pauses a send resumed early again. MailCheap Cloud only, like the warm-up.
export async function backOffSender({ accountId, newsletterId, reason, now = new Date() }) {
	if (!isCloud()) return { skipped: "self-hosted" };
	await connectDb();
	const account = { _id: accountId };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).select({ name: 1, fromEmail: 1, slug: 1, sendingDomain: 1 }).lean();
	if (!newsletter) return { skipped: "newsletter not found" };
	const domain = newsletter.sendingDomain ?? getSendingDomain(newsletter);
	const newsletterIds = await findDomainNewsletterIds(account, domain);
	const backoff = await claimBackoff(account, domain, newsletterIds, now);
	const paused = await pauseRateLimitedSends({ accountId, newsletterIds, reason: RATE_LIMIT_REASON, resumeAt: backoff.resumeAt });
	if (!backoff.isNew) return { paused, skipped: "already backing off" };

	const sends = paused.length === 1 ? "Its send paused" : `Its ${paused.length} sends paused`;
	await sendAlert({
		accountId: null,
		key: `gmail-backoff:${newsletterId}`,
		title: "Gmail is rate limiting a newsletter",
		detail: `${newsletter.name} (${domain}), account ${accountId}. Gmail answered: ${reason}`,
		action: `${paused.length ? sends : "Nothing was going out"} for ${BACKOFF.hours} hours, then its domain warms up again from ${formatNumber(backoff.firstDay)} emails a day. If it happens again, look at where its contacts came from.`,
		path: `/admin/newsletters/${newsletterId}`,
	});
	return { paused, firstDay: backoff.firstDay, resumeAt: backoff.resumeAt };
}

const GMAIL_ADDRESS = new RegExp(`@(${GMAIL_DOMAINS.map((domain) => domain.replaceAll(".", "\\.")).join("|")})$`);

// A send's emails to Gmail delayed without a reason (Resend's): when they pile up (GMAIL_DELAYS), it's Gmail rate
// limiting the sender as surely as its 4.7.28 would say. MailCheap Cloud backs the newsletter off; a self-hosted server,
// without the warm-up to resume into, emails the owner once a day per send, for them to pause it.
export async function checkGmailDelays({ accountId, campaignId, newsletterId, type, now = new Date() }) {
	const account = { _id: accountId };
	const since = new Date(now.getTime() - GMAIL_DELAYS.minutes * 60_000);
	const delayedIds = await Event.distinct("messageId", scoped(account, { campaignId, type, occurredAt: { $gte: since }, email: GMAIL_ADDRESS }));
	const delayed = delayedIds.filter(Boolean).length;
	if (delayed < GMAIL_DELAYS.emails) return { delayed };
	const sentToGmail = await Message.countDocuments(scoped(account, { campaignId, email: GMAIL_ADDRESS }));
	if (!isGmailDelayPileUp({ delayed, sentToGmail })) return { delayed, sentToGmail };

	const reason = `Gmail delayed ${formatCount(delayed, "email")} of the ${formatNumber(sentToGmail)} this send has for Gmail in the last ${formatCount(GMAIL_DELAYS.minutes, "minute")}, without saying why`;
	if (isCloud()) return { delayed, sentToGmail, ...(await backOffSender({ accountId, newsletterId, reason, now })) };
	await sendAlert({
		accountId,
		key: `gmail-delays-${campaignId}`,
		title: "Gmail is holding back a send",
		detail: `${reason}. That's how Gmail asks a sender to slow down.`,
		action: "If it's still going out, pause it for a few hours, then resume it. If it happens again, look at where its contacts came from.",
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 24 * 60,
	});
	return { delayed, sentToGmail, alerted: true };
}
