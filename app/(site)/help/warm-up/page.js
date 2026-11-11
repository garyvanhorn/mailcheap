import Link from "next/link";
import ArticleHelp from "@/components/ArticleHelp";
import LinkApp from "@/components/LinkApp";
import { BACKOFF, FIRST_SEND, GMAIL_DELAYS, SENDER_WARMUP, WARMUP, getSharedDomain } from "@/lib/config";
import { formatCount, formatNumber } from "@/lib/format";
import { getHelpHref, getHelpPageMetadata } from "@/lib/help";
import { getAllowance, getPaceHours, getSenderDayEmails } from "@/lib/send-spread";

export const metadata = getHelpPageMetadata("warm-up");

// A new account's first issue to contacts it never emailed, from a newsletter whose address never sent, paced the way
// the send step says it.
const FIRST_ISSUES = [WARMUP.quickEmails, 1_000, 5_000, 20_000];
const NEW_ADDRESS = { day: 1, intoDayMs: 0, waitMs: 0, firstDay: SENDER_WARMUP.firstDay, inFlight: 0 };
const NEW_ACCOUNT = { proven: 0, recent: 0, warmup: { day: 1 }, sender: NEW_ADDRESS };
const ADDRESS_DAYS = Array.from({ length: 4 }, (_, index) => getSenderDayEmails(NEW_ADDRESS, index + 1));

export default function WarmupPage() {
	const afterClean = Math.floor(getAllowance({ proven: 1_000, day: 2 }) / 100) * 100;
	const sharedDomain = getSharedDomain();

	return (
		<ArticleHelp slug="warm-up">
			<h2 id="what">What warming up means</h2>
			<p>
				Inboxes like Gmail, Yahoo and Outlook watch how a new sender&apos;s volume grows. A new account that sends thousands of emails
				at once looks like a spammer and lands in spam. One whose volume grows step by step, with few bounces and complaints, earns a
				reputation that gets its emails to the inbox.
			</p>
			<p>
				So for the {WARMUP.days} days after its first campaign, your account sends gradually: each send goes out at full speed up to
				what your account has shown it can send cleanly, and a bigger one is spread over a few hours. If a list has a problem, it shows
				in the first hours instead of in every inbox.
			</p>
			<p>
				Inboxes also judge each sending address on its own, so a newsletter&apos;s address warms up too, for its first{" "}
				{formatCount(SENDER_WARMUP.days, "day")}. <Link href="#new-address">A new address&apos;s first week</Link>
			</p>

			<h2 id="pace">How a send&apos;s pace is set</h2>
			<ul>
				<li>
					<strong>From the start, up to {formatNumber(WARMUP.quickEmails)} emails go out at once.</strong>
				</li>
				<li>
					<strong>Your proven volume</strong> is your largest campaign of the last {WARMUP.provenDays} days whose bounces and
					complaints stayed low, counted a day after it went out, once they&apos;ve come in.
				</li>
				<li>
					<strong>A send goes out at once</strong> up to your proven volume times {WARMUP.growth.first} on the first day of the
					warm-up. That multiplier grows a little each day, to {WARMUP.growth.last} on day {WARMUP.days}.
				</li>
				<li>
					<strong>A bigger send goes out over {formatCount(WARMUP.minHours, "hour")}</strong>, plus {WARMUP.hoursPerDoubling} for each
					time it doubles that, {formatCount(WARMUP.maxHours / 24, "day")} at most. Its first emails leave right away, the last ones at
					the end, the others evenly between.
				</li>
				<li>
					<strong>Sends count together</strong>: what your other sends still have to send, or sent in the last{" "}
					{formatCount(WARMUP.recentHours, "hour")}, adds to a new one, so splitting a send doesn&apos;t make it faster.
				</li>
			</ul>
			<p>
				For example, a day after a clean send to 1,000 contacts, a send of up to about {formatNumber(afterClean)} goes out at once. A
				new account&apos;s first issue, to contacts it never emailed and from a newsletter address that never sent, goes out over:
			</p>
			<table>
				<thead>
					<tr>
						<th>First issue to</th>
						<th>Goes out over</th>
					</tr>
				</thead>
				<tbody>
					{FIRST_ISSUES.map((emails) => {
						const hours = getPaceHours(NEW_ACCOUNT, { emails, newContacts: emails });
						return (
							<tr key={emails}>
								<td>{formatCount(emails, "contact")}</td>
								<td>
									{!hours ? "At once" : hours < 48 ? `About ${formatCount(hours, "hour")}` : `About ${formatCount(Math.round(hours / 24), "day")}`}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p>
				Those times include the {FIRST_SEND.waitMinutes / 60}-hour check that follows the first slice of contacts you never emailed.{" "}
				<Link href={getHelpHref("sending", "first-send")}>First sends in steps</Link>
			</p>

			<h2 id="new-address">A new address&apos;s first week</h2>
			<p>
				Gmail and the other inboxes keep a history for each address that sends: your own domain
				{sharedDomain && (
					<>
						, or the address made from a newsletter&apos;s slug, like <code>your-newsletter.{sharedDomain}</code>
					</>
				)}
				. An address they&apos;ve never seen that sends thousands of emails in a day gets held back, whatever the account behind it.
				So for {formatCount(SENDER_WARMUP.days, "day")} from its first campaign email, a newsletter&apos;s address sends:
			</p>
			<ul>
				<li>
					<strong>{formatNumber(ADDRESS_DAYS[0])} emails on its first day</strong>, then twice as many each day:{" "}
					{ADDRESS_DAYS.slice(1).map(formatNumber).join(", ")} and so on.
				</li>
				<li>
					<strong>Each day&apos;s emails spread over the day.</strong> The first {formatNumber(WARMUP.quickEmails)} of a send go
					at once, and a bigger send carries on over the next days.
				</li>
				<li>
					<strong>One week per domain</strong>: newsletters sending from the same domain share it, so their emails add up.
				</li>
				<li>
					<strong>Again from day one when it moves</strong>: a newsletter that switches to your own domain, or to another one,
					starts its new address&apos;s first week.
				</li>
			</ul>
			<p>
				This comes on top of your account&apos;s warm-up: a send goes at the slower of the two paces, and the send step says which
				one sets it.
			</p>

			<h2 id="gmail">When Gmail asks to slow down</h2>
			<p>
				Sometimes Gmail still finds an address&apos;s volume unusual. It then holds back its emails and asks the sender to slow
				down. Sending on would make it worse, so MailCheap pauses the sends from that address for{" "}
				{formatCount(BACKOFF.hours, "hour")} and emails you. Then they go on by themselves, the address warming up again from half
				the emails it sent in the day before, twice as many each day after. Resuming earlier, or moving to another address, still
				waits for those hours.
			</p>
			<p>
				Some email providers don&apos;t pass Gmail&apos;s words on, only that an email is delayed. Then MailCheap counts them: once
				Gmail delays {formatCount(GMAIL_DELAYS.emails, "email")} of a send in {formatCount(GMAIL_DELAYS.minutes, "minute")}, and at
				least one in {formatNumber(Math.round(1 / GMAIL_DELAYS.share))} of those it sends to Gmail, it pauses the same way. On your
				own server, without the warm-up, it emails you instead, for you to pause the send.
			</p>
			<p>
				If it keeps happening, the contacts probably didn&apos;t expect your emails: check where they came from before you send
				again. <Link href={getHelpHref("deliverability")}>Bounces, complaints and pauses</Link>
			</p>

			<h2 id="dashboard">Where you see it</h2>
			<p>
				Wherever your sending warms up or slows down, the dashboard shows the same box, with a flame: what&apos;s happening, the day
				each warm-up is on, what goes out now and what comes next.
			</p>
			<ul>
				<li>
					The <LinkApp href="/">overview</LinkApp> shows your account&apos;s warm-up and the open newsletter&apos;s address&apos;s,
					while they last.
				</li>
				<li>
					The send step says when an issue will be spread, over how many hours or days, and which warm-up sets that pace. A send at
					full speed only shows your account&apos;s day. When an issue reaches contacts you never emailed, the box lists its steps: the
					slice that goes first, then the rest.
				</li>
				<li>
					A <LinkApp href="/campaigns">campaign</LinkApp> going out gradually says how long it has left and where its warm-up is, and
					one Gmail paused says when it starts again.
				</li>
			</ul>
			<p>
				A scheduled issue follows the same pace from its send time. Paused and resumed, a send keeps its pace, and each step of a send
				to more contacts gets its own.
			</p>

			<h2 id="after">After the warm-up</h2>
			<p>
				After day {WARMUP.days}, a send goes out at once up to {WARMUP.growth.last} times your proven volume. A much bigger one, like a
				first send to a newly imported list, is still spread over hours, the same way. Each clean send raises your proven volume, so
				growing your list gradually keeps your sends fast.
			</p>
			<p>
				Bounces and complaints matter during the warm-up and after it.{" "}
				<Link href={getHelpHref("deliverability")}>Bounces, complaints and pauses</Link>
			</p>
		</ArticleHelp>
	);
}
