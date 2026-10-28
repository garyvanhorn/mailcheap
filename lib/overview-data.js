import "server-only";
import { MESSAGE_STATS_GROUP } from "@/lib/message-stats";
import {
	PERIOD_DAYS,
	buildHourlySeries,
	buildSubscriberSeries,
	periodDayKeys,
	splitPeriods,
} from "@/lib/overview-series";
import { DEFAULT_TIME_ZONE, hourIn, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Suppression from "@/models/Suppression";

const DAY_MS = 24 * 60 * 60 * 1000;
const STAT_KEYS = Object.keys(MESSAGE_STATS_GROUP);
const LEFT_STATUSES = ["unsubscribed", "bounced", "complained"];
const IMPORT_SOURCES = ["import"];
// Imports write the unsubscribe time (and suppressions) as they create the contact, so a leave
// recorded within a minute of creation happened before the contact came to MailCheap, at an unknown date.
const IMPORT_WINDOW_MS = 60_000;
const UNKNOWN_TIME_ZONE_CODE = 40485;

// The later of the two: a contact who subscribes again gets a new subscribedAt but keeps an old confirmedAt.
const joinedAt = { $max: ["$subscribedAt", "$confirmedAt"] };
// Imported rows without a signup date get the import time: those contacts joined earlier, on an unknown
// day, so they count from the start of the chart rather than as a spike on the import day.
const joinedBeforeImport = {
	$and: [
		{ $in: ["$source", IMPORT_SOURCES] },
		{ $lt: [{ $abs: { $subtract: ["$subscribedAt", "$createdAt"] } }, IMPORT_WINDOW_MS] },
	],
};

function dayOf(date, timeZone) {
	return { $dateToString: { date, format: "%Y-%m-%d", timezone: timeZone } };
}

// The day a contact joined, or null when it was before the range (or unknown): they're in the starting count.
function joinedDay(rangeStart, timeZone) {
	return {
		$cond: [{ $or: [joinedBeforeImport, { $lt: [joinedAt, rangeStart] }] }, null, dayOf(joinedAt, timeZone)],
	};
}

function joinedKey(contact, rangeStart, timeZone) {
	const joined = new Date(Math.max(contact.subscribedAt ?? 0, contact.confirmedAt ?? 0));
	const isImportTime =
		IMPORT_SOURCES.includes(contact.source) &&
		Math.abs(contact.subscribedAt - contact.createdAt) < IMPORT_WINDOW_MS;
	return isImportTime || joined < rangeStart ? null : toDateKey(joined, timeZone);
}

// MongoDB's timezone list can lag the browser's; such a zone falls back to UTC rather than failing the page.
async function aggregateInZone(model, buildPipeline, timeZone) {
	try {
		return await model.aggregate(buildPipeline(timeZone));
	} catch (error) {
		if (error?.code !== UNKNOWN_TIME_ZONE_CODE || timeZone === DEFAULT_TIME_ZONE) throw error;
		return model.aggregate(buildPipeline(DEFAULT_TIME_ZONE));
	}
}

function hasLeftInMailcheap(leftAt, contact) {
	return Boolean(leftAt) && leftAt.getTime() > contact.createdAt.getTime() + IMPORT_WINDOW_MS;
}

// Active subscribers at the end of each of the last 60 days. Active contacts count from the day they
// joined (confirmed, for confirmed opt-in; CSV imports keep the file's signup date). Contacts who
// left count until they left, when MailCheap knows the date: unsubscribedAt, or the suppression a bounce
// or complaint created. Pending, dormant and contacts imported as unsubscribed or bounced have no such
// date and are left out of every day.
export async function getSubscriberHistory({ accountId, newsletterId, timeZone, now = new Date() }) {
	const dayKeys = periodDayKeys(toDateKey(now, timeZone));
	const rangeStart = startOfDateKey(dayKeys[0], timeZone);

	const [activeBefore, activeJoins, unsubscribes, suppressions] = await Promise.all([
		Contact.countDocuments({ accountId, newsletterId, status: "active", subscribedAt: { $lt: rangeStart } }),
		aggregateInZone(
			Contact,
			(zone) => [
				{ $match: { accountId, newsletterId, status: "active", subscribedAt: { $gte: rangeStart } } },
				{ $group: { _id: joinedDay(rangeStart, zone), count: { $sum: 1 } } },
			],
			timeZone
		),
		aggregateInZone(
			Contact,
			(zone) => [
				{
					$match: {
						accountId,
						newsletterId,
						status: { $in: LEFT_STATUSES },
						unsubscribedAt: { $gte: rangeStart },
						$expr: { $gt: ["$unsubscribedAt", { $add: ["$createdAt", IMPORT_WINDOW_MS] }] },
					},
				},
				{
					$group: {
						_id: { joined: joinedDay(rangeStart, zone), left: dayOf("$unsubscribedAt", zone) },
						count: { $sum: 1 },
					},
				},
			],
			timeZone
		),
		// Each recent suppression with this newsletter's contact for the address, in the same round trip.
		Suppression.aggregate([
			{
				$match: {
					accountId,
					reason: { $in: ["bounce", "complaint"] },
					detail: { $nin: IMPORT_SOURCES },
					createdAt: { $gte: rangeStart },
				},
			},
			{
				$lookup: {
					from: Contact.collection.collectionName,
					localField: "email",
					foreignField: "email",
					pipeline: [
						{ $match: { newsletterId, status: { $in: ["bounced", "complained"] } } },
						{ $project: { source: 1, subscribedAt: 1, confirmedAt: 1, unsubscribedAt: 1, createdAt: 1 } },
					],
					as: "contact",
				},
			},
			{ $unwind: "$contact" },
			{ $project: { _id: 0, leftAt: "$createdAt", contact: 1 } },
		]),
	]);

	let baseline = activeBefore;
	const joins = {};
	const leaves = {};
	function addLeaver(joinedKey, leftKey, count = 1) {
		if (joinedKey) joins[joinedKey] = (joins[joinedKey] ?? 0) + count;
		else baseline += count;
		leaves[leftKey] = (leaves[leftKey] ?? 0) + count;
	}

	for (const { _id, count } of activeJoins) {
		if (_id) joins[_id] = (joins[_id] ?? 0) + count;
		else baseline += count;
	}
	for (const { _id, count } of unsubscribes) addLeaver(_id.joined, _id.left, count);
	for (const { leftAt, contact } of suppressions) {
		if (hasLeftInMailcheap(contact.unsubscribedAt, contact) || !hasLeftInMailcheap(leftAt, contact)) continue;
		addLeaver(joinedKey(contact, rangeStart, timeZone), toDateKey(leftAt, timeZone));
	}

	return splitPeriods(buildSubscriberSeries({ dayKeys, baseline, joins, leaves }));
}

function emptyStats() {
	return Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
}

// Issues of the last 30 days and the 30 days before. Welcome and confirmation emails go out untracked
// (lib/sending.js), so counting them would only lower the open and click rates.
export async function getEmailStats({ accountId, newsletterId, now = new Date() }) {
	const since = new Date(now.getTime() - PERIOD_DAYS * DAY_MS);
	const previousSince = new Date(now.getTime() - 2 * PERIOD_DAYS * DAY_MS);
	const period = (field) => ({ $cond: [{ $gte: [field, since] }, "current", "previous"] });

	const rows = await Campaign.aggregate([
		{ $match: { accountId, newsletterId } },
		{ $project: { at: { $ifNull: ["$startedAt", "$sentAt"] }, stats: 1 } },
		{ $match: { at: { $gte: previousSince } } },
		{
			$group: {
				_id: period("$at"),
				...Object.fromEntries(STAT_KEYS.map((key) => [key, { $sum: `$stats.${key}` }])),
			},
		},
	]);

	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const row of rows) {
		for (const key of STAT_KEYS) totals[row._id][key] += row[key] || 0;
	}
	return totals;
}

// Every email SES accepted for the newsletter (issues, welcome, confirmation and test emails), by hour
// of today and yesterday.
export async function getHourlySends({ accountId, newsletterId, timeZone, now = new Date() }) {
	const todayKey = toDateKey(now, timeZone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), timeZone);
	const rows = await aggregateInZone(
		Message,
		(zone) => [
			{ $match: { accountId, newsletterId, sentAt: { $gte: since } } },
			{
				$group: {
					_id: { day: dayOf("$sentAt", zone), hour: { $hour: { date: "$sentAt", timezone: zone } } },
					count: { $sum: 1 },
				},
			},
		],
		timeZone
	);
	return buildHourlySeries({
		rows: rows.map(({ _id, count }) => ({ ..._id, count })),
		todayKey,
		currentHour: hourIn(now, timeZone),
	});
}
