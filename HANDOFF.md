# HANDOFF: mailto:bot (repo mailcheap)

mailto:bot is Gary's fork of MailCheap, the open source newsletter app (AGPL-3.0). It runs at app.mailtobot.io
(Vercel project `mailtobot`, team GVX Digital) and sends MachinaTechnica. Read `AGENTS.md` before changing code.
Upstream is `marclou/mailcheap`; this fork is `garyvanhorn/mailcheap`, default branch `main`.

## Now
- Nov 11: branch `claude/next-2026-11-11` (draft PR #11) makes Resend notice Gmail's rate limit. Resend's `email.delivery_delayed` events carry no reason, so the 4.7.28 check never fired. Now, when Gmail delays at least 20 of one send's emails in an hour, and at least one in ten of that send's Gmail emails (`GMAIL_DELAYS` in `lib/config.js`), MailCheap Cloud backs the newsletter off as if Gmail had said 4.7.28, and a self-hosted server emails the owner once a day per send ("Gmail is holding back a send") so they can pause it. The help article `/help/warm-up#gmail` says so.
- Its pure tests and lint pass here. The integration test ("Gmail delaying many of a send's emails...", `tests/resend.test.mjs`) needs `mongod`, which this cloud session couldn't download, so it hasn't run yet. Run `npm test` before merging.
- PR #10 merged Nov 4 (`c862205`): #9's changes are on `main`.
- Sending goes through Resend (`EMAIL_PROVIDER=resend`). Amazon SES production access was denied on Nov 1, 2026: don't reapply. The SES code path stays in the code.
- Transmission 001 went out on Oct 29 from app.mailtobot.io (MachinaTechnica's newsletter). Its design is Midnight with custom colors: don't reset it.
- The dark email template is checked in Gmail web and Gmail iOS only; Outlook, Yahoo, Apple Mail, Gmail Android and iCloud are untested.

## Needs Gary
- Review the Gmail delay detection PR, run `npm test` locally (needs `mongod`), then merge: https://github.com/garyvanhorn/mailcheap/pull/11
- Assumed a self-hosted server (what app.mailtobot.io runs, unless `MAILCHEAP_CLOUD=true` is set) only emails you when Gmail delays pile up, instead of pausing the send by itself: the automatic pause and resume belong to the Cloud warm-up. Say if you want it to pause by itself too.
- Assumed 20 delayed Gmail emails in an hour, and at least 10% of the send's Gmail emails, as the threshold; say if MachinaTechnica's list is small enough that you want it lower.
- Assumed this fork keeps the AGPL source link pointing at upstream until `NEXT_PUBLIC_SOURCE_URL` is set in Vercel to `https://github.com/garyvanhorn/mailcheap`; set it if you want the fork's own link shown (no code change needed).
- Add a database name to `MONGODB_URI` in Vercel (Gary's to set).

## Next
- Once the delay detection is merged and a send has gone out: check Vercel logs for `[alert] ... Gmail is holding back a send` to see whether the threshold is right.
- Show delayed emails on a campaign's report (the `email.delivery_delayed` events are already stored in `Event`).
- Fork cosmetics: README badges, Deploy button and `SECURITY.md` still point at `marclou/mailcheap`; decide which stay as upstream credit and which point at the fork (`lib/site.js` already reads `NEXT_PUBLIC_SOURCE_URL`). Plus a mailtobot.io favicon.
- Stacked PRs: merge the bottom one, then retarget the next to `main` before merging it, or its changes land on a dead branch (what happened to #9).
- Dark email: test in Outlook and Yahoo only if Gary sets up inboxes there.

## Reference
- Tests: `npm test` (Node 22+). Lint: `npm run lint`.
- Env var names only (values are Gary's): `MONGODB_URI`, `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SENDING_ENABLED`, plus the AWS SES variables.
- Sign-in is by a code emailed to Gary. An agent never types the code.
- MachinaTechnica's notes on this app: `~/Code/machinatechnica/docs/HANDOFF.md` (read only from here).
