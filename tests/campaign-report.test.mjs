import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: CampaignReport } = await import("../components/CampaignReport.jsx");

const STATS = { recipients: 1000, sent: 1000, delivered: 990, opened: 462, clicked: 70, bounced: 10, complained: 1, unsubscribed: 4 };

function renderReport(props = {}) {
	return renderToStaticMarkup(
		createElement(CampaignReport, {
			campaign: { _id: "6ad87a2affc219b3be2cc72c", subject: "Hello", status: "sent", format: "markdown", markdown: "Hi", stats: STATS },
			newsletter: { name: "Weekly", fromName: "Weekly", fromEmail: "hi@example.com" },
			providers: [],
			links: null,
			comparison: { isSettled: true, issues: 3, delta: { opened: 0.042, clicked: -0.004 }, average: { opened: 0.42, clicked: 0.074 } },
			timeZone: "UTC",
			...props,
		})
	);
}

const card = (label) => `>${label}</span>`;

test("the report's cards are delivered, opened, clicked, bounced and unsubscribed, with complaints only for an admin", () => {
	const owner = renderReport();
	const cards = ["Delivered", "Opened", "Clicked", "Bounced", "Unsubscribed"].map((label) => owner.indexOf(card(label)));
	assert.ok(cards.every((index, position) => index > (cards[position - 1] ?? -1)), "all five, in that order");
	assert.ok(!owner.includes(card("Complaints")), "the owner sees complaints by inbox instead");

	const admin = renderReport({ readOnly: true });
	assert.ok(admin.indexOf(card("Bounced")) < admin.indexOf(card("Complaints")));
	assert.ok(admin.indexOf(card("Complaints")) < admin.indexOf(card("Unsubscribed")));
});

test("the report's links come below its results by inbox", () => {
	const html = renderReport({
		providers: [{ provider: "gmail", sent: 600, delivered: 595, opened: 300, clicked: 50, bounced: 5, complained: 0 }],
		links: { links: [{ key: "post", url: "https://example.com/post", clickers: 40, clicks: 50 }], clickers: 40, isComplete: true },
	});
	const inbox = html.indexOf(">Inbox</th>");
	assert.ok(inbox > -1, "the inbox table shows");
	assert.ok(html.indexOf(">Link</th>") > inbox, "the links table follows it");
});

test("Gmail's row in the inbox table shows Gmail's logo, and other inboxes their favicon", () => {
	const html = renderReport({
		providers: [
			{ provider: "gmail", sent: 600, delivered: 595, opened: 300, clicked: 50, bounced: 5, complained: 0 },
			{ provider: "outlook", sent: 400, delivered: 395, opened: 162, clicked: 20, bounced: 5, complained: 1 },
		],
	});
	assert.ok(html.includes('<svg viewBox="52 42 88 66" width="16" height="16"'), "Gmail's own logo");
	assert.ok(!html.includes("s2/favicons?domain=gmail.com"), "the favicon service answers gmail.com with Google's G");
	assert.ok(html.includes("s2/favicons?domain=outlook.com&amp;"));
});

const HOUR_MS = 3_600_000;
const inHours = (hours) => new Date(Date.now() + hours * HOUR_MS - 60_000).toISOString();
const sending = (campaign) => ({
	_id: "6ad87a2affc219b3be2cc72c",
	subject: "Hello",
	format: "markdown",
	markdown: "Hi",
	stats: { ...STATS, sent: 200 },
	...campaign,
});
const newAddress = { day: 2, intoDayMs: HOUR_MS, waitMs: 0, firstDay: 1_000, inFlight: 0, hasStarted: true, domain: "news.example.com" };

test("a send going out gradually and in steps says where its warm-up is, what comes next, and why", () => {
	const html = renderReport({
		campaign: sending({ status: "sending", sendingUntil: inHours(10), spreadHours: 12, firstSend: { slice: 200, held: 800, checkAt: inHours(2) } }),
		pace: { proven: 10_000, recent: 0, warmup: null, sender: newAddress },
	});
	assert.match(html, /Going out gradually: about 10 hours to go/);
	assert.match(html, /Day 2 of 7/);
	assert.match(html, /2,000 emails today\./);
	assert.match(html, /Next: 4,000 tomorrow, full speed in 6 days\./);
	assert.match(html, /200 contacts who never got an email from you go first\./);
	assert.match(html, /The other 800 follow in about 2 hours, if few bounce or complain\./);
	assert.match(html, /href="\/help\/warm-up"/);

	const steps = renderReport({ campaign: sending({ status: "sending", firstSend: { slice: 200, held: 800, checkAt: inHours(2) } }), pace: null });
	assert.match(steps, /Going out in steps/);
	assert.match(steps, /href="\/help\/sending#first-send"/);
	assert.doesNotMatch(steps, /role="progressbar"/, "no warm-up to show");
});

test("a send Gmail paused says when it starts again, in the warm-up's look", () => {
	const campaign = sending({
		status: "paused",
		pauseCode: "rate_limited",
		pauseReason: "Gmail asked to slow down, so this newsletter's sends wait 6 hours, then go on by themselves, more slowly at first",
	});
	// Read only: without its buttons, whose tooltips need the dashboard's provider.
	const html = renderReport({
		campaign,
		readOnly: true,
		pace: { proven: 10_000, recent: 0, warmup: null, sender: { ...newAddress, day: 1, intoDayMs: 0, waitMs: 4 * HOUR_MS, firstDay: 500 } },
	});
	assert.match(html, /Paused: Gmail asked to slow down/);
	assert.match(html, /Starts again in 4 hours: 500 emails that day\./);
	assert.match(html, /Next: twice as many each day after\./);
	assert.match(html, /href="\/help\/warm-up#gmail"/);
	assert.doesNotMatch(html, /Paused: Gmail asked to slow down, so/, "not the look of a pause that needs something from its owner");

	const withoutPace = renderReport({ campaign, readOnly: true, pace: null });
	assert.match(withoutPace, /this newsletter&#x27;s sends wait 6 hours/, "the reason, when the domain's warm-up isn't there to say it");
});

test("the report compares opens and clicks with the average in percent, never in points", () => {
	const html = renderReport();
	assert.ok(html.includes("+4.2%"));
	assert.ok(html.includes("−0.4%"));
	assert.ok(!/\bpts\b/.test(html));
});

test("the inbox table shows delayed emails only once an inbox delayed some", () => {
	const rows = (gmailDelayed) => [
		{ provider: "gmail", sent: 600, delivered: 595, opened: 300, clicked: 50, bounced: 5, complained: 0, delayed: gmailDelayed },
		{ provider: "outlook", sent: 400, delivered: 395, opened: 162, clicked: 20, bounced: 5, complained: 1, delayed: 0 },
	];
	assert.ok(!renderReport({ providers: rows(0) }).includes(">Delayed</th>"), "no column while nothing was delayed");

	const html = renderReport({ providers: rows(60) });
	assert.ok(html.indexOf(">Delayed</th>") > html.indexOf(">Clicked</th>"));
	assert.ok(html.indexOf(">Delayed</th>") < html.indexOf(">Bounced</th>"));
	assert.ok(html.includes(">10.0%</td>"), "60 of Gmail's 600");
});
