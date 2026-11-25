# HANDOFF: mailto:bot (repo mailcheap)

mailto:bot is Gary's fork of MailCheap, the open source newsletter app (AGPL-3.0). It runs at app.mailtobot.io
(Vercel project `mailtobot`, team GVX Digital) and sends MachinaTechnica. Read `AGENTS.md` before changing code.
Upstream is `marclou/mailcheap`; this fork is `garyvanhorn/mailcheap`, default branch `main`.

## Now
- Nov 25: branch `claude/next-2026-11-25` (draft PR, link under Needs Gary) does the fork cosmetics. The footer's "Source code" link now defaults to this fork (`lib/site.js`), so app.mailtobot.io offers the code it runs, as the AGPL asks, without `NEXT_PUBLIC_SOURCE_URL`. The README's license badge, Deploy button and `git clone` point at the fork, with one line saying it's mailto:bot's fork of MailCheap. `SECURITY.md` sends reports to the fork's Security tab, and flaws in MailCheap's own code can go upstream too. Kept upstream: the mailcheap.ai links, the copyright, "Made by Marc Lou" and the MIT commit link.
- Its branding test and lint pass. This run couldn't get `mongod` either (fastdl.mongodb.org is still blocked), so the integration tests still haven't run here.
- Nov 18: branch `claude/next-2026-11-18` (draft PR #12) shows delayed emails on a campaign's report. The inbox table gets a Delayed column, once any inbox held some emails back: how many of each inbox's emails were delayed at least once, as a share of what it was sent. The API's and MCP's `get_campaign_report` returns `providers[].delayed`, and the help article `/help/sending#report` says so. It reads the delay events already stored in `Event` (Resend `email.delivery_delayed`, SES `DeliveryDelay`, PostShiba `deferred`); nothing new is stored.
- Its pure tests (render, row merge, each provider's delay name) and lint pass here. The integration test ("the report counts each inbox's delayed emails once...", `tests/link-stats.test.mjs`) needs `mongod`, which this cloud session still can't download (fastdl.mongodb.org is blocked), so it hasn't run. Run `npm test` before merging.
- Nov 11: draft PR #11 (`claude/next-2026-11-11`) makes Resend notice Gmail's rate limit: when Gmail delays at least 20 of one send's emails in an hour, and one in ten of its Gmail emails, MailCheap Cloud backs off and a self-hosted server emails the owner. Not merged yet; its integration test hasn't run either. The two PRs touch different code; only `HANDOFF.md` conflicts (keep the newer one).
- `main` is still at `c862205` (Nov 4, PR #10). PRs #11 and #12 are open drafts, waiting on Gary.
- Sending goes through Resend (`EMAIL_PROVIDER=resend`). Amazon SES production access was denied on Nov 1, 2026: don't reapply. The SES code path stays in the code.
- Transmission 001 went out on Oct 29 from app.mailtobot.io (MachinaTechnica's newsletter). Its design is Midnight with custom colors: don't reset it.
- The dark email template is checked in Gmail web and Gmail iOS only; Outlook, Yahoo, Apple Mail, Gmail Android and iCloud are untested.

## Needs Gary
- Review the delayed-emails report PR, run `npm test` locally (needs `mongod`), then merge: https://github.com/garyvanhorn/mailcheap/pull/12
- Review PR #11 (Gmail delay detection), run `npm test`, then merge: https://github.com/garyvanhorn/mailcheap/pull/11
- Assumed the Delayed column shows only once a send has a delayed email, between Clicked and Bounced, hidden on phones like Bounced; say if you want it always there.
- Assumed a self-hosted server only emails you when Gmail delays pile up (PR #11), instead of pausing the send by itself; say if you want it to pause too.
- Review the fork cosmetics PR (source link, README, SECURITY.md), then merge: https://github.com/garyvanhorn/mailcheap/pulls?q=head%3Aclaude%2Fnext-2026-11-25
- Assumed the footer's source link, the license badge, the Deploy button, `git clone` and security reports point at this fork, and the mailcheap.ai links, the copyright and the credit stay upstream's; say if you want otherwise. `NEXT_PUBLIC_SOURCE_URL` no longer needs setting.
- Turn on private vulnerability reporting for the fork, or SECURITY.md's link leads nowhere: https://github.com/garyvanhorn/mailcheap/settings/security_analysis
- Add a database name to `MONGODB_URI` in Vercel (Gary's to set): https://vercel.com/dashboard
- Optional: allow `fastdl.mongodb.org` in this cloud environment's network policy, so scheduled runs can run the integration tests (https://code.claude.com/docs/en/claude-code-on-the-web).

## Next
- Once both PRs are merged and a send has gone out: compare the report's Delayed column for Gmail with the `[alert] ... Gmail is holding back a send` lines in Vercel's logs, to check PR #11's threshold.
- Delayed emails on the admin campaign page (`app/admin/campaigns/[id]`) and in the account's daily summary (`lib/summary-data.js`), if the report's column proves useful.
- A mailtobot.io favicon and README logo, once Gary has a mark to use.
- Stacked PRs: merge the bottom one, then retarget the next to `main` before merging it, or its changes land on a dead branch (what happened to #9).
- Dark email: test in Outlook and Yahoo only if Gary sets up inboxes there.

## Reference
- Tests: `npm test` (Node 22+). Lint: `npm run lint`.
- Env var names only (values are Gary's): `MONGODB_URI`, `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SENDING_ENABLED`, plus the AWS SES variables.
- Sign-in is by a code emailed to Gary. An agent never types the code.
- MachinaTechnica's notes on this app: `~/Code/machinatechnica/docs/HANDOFF.md` (read only from here).
