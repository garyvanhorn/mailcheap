# HANDOFF: mailto:bot (repo mailcheap)

mailto:bot is Gary's fork of MailCheap, the open source newsletter app (AGPL-3.0). It runs at app.mailtobot.io
(Vercel project `mailtobot`, team GVX Digital) and sends MachinaTechnica. Read `AGENTS.md` before changing code.
Upstream is `marclou/mailcheap`; this fork is `garyvanhorn/mailcheap`, default branch `main`.

## Now
- PR #9 (stacked on #8) records that Resend's `email.delivery_delayed` events carry no reason, so Gmail's `4.7.28` never pauses sends on Resend; adds a test, and names Resend in the README intro and AGENTS.md.
- Sending goes through Resend (`EMAIL_PROVIDER=resend`). Amazon SES production access was denied on Nov 1, 2026: don't reapply. The SES code path stays in the code.
- `main` is at `074b020` (Oct 29): PRs #1 to #7 merged (branding through settings, Redis `KV_` names, first-domain fix, Resend, untracked welcome emails, dark themes in every client and Gmail iOS). No open PRs.
- Transmission 001 went out on Oct 29 from app.mailtobot.io (MachinaTechnica's newsletter). Its design is Midnight with custom colors: don't reset it.
- The dark email template is checked in Gmail web and Gmail iOS only; Outlook, Yahoo, Apple Mail, Gmail Android and iCloud are untested.
- The main checkout sits on `fix/gmail-ios-dark` (already merged). Start new work from `origin/main` in a worktree.

## Needs Gary
- Review and merge PR #9 after #8 (Resend delay events, docs): https://github.com/garyvanhorn/mailcheap/pull/9
- Review and merge this HANDOFF PR (Nov 1 scheduled run): https://github.com/garyvanhorn/mailcheap/pull/8
- Assumed this fork keeps the AGPL source link pointing at upstream until `NEXT_PUBLIC_SOURCE_URL` is set in Vercel to `https://github.com/garyvanhorn/mailcheap`; set it if you want the fork's own link shown (no code change needed).

## Next
- Fork cosmetics: README badges, Deploy button and `SECURITY.md` still point at `marclou/mailcheap`; decide which stay as upstream credit and which point at the fork (`lib/site.js` already reads `NEXT_PUBLIC_SOURCE_URL`).
- Deliverability: on Resend, nothing notices a Gmail rate limit (delay events have no reason, and `backOffSender` only runs with `MAILCHEAP_CLOUD=true`). Next idea: pause a newsletter when Gmail delays pile up (count `email.delivery_delayed` to Gmail addresses per send), behind a test.
- Add a database name to `MONGODB_URI` in Vercel (Gary's to set) and a mailtobot.io favicon.
- Dark email: test in Outlook and Yahoo only if Gary sets up inboxes there.

## Reference
- Tests: `npm test` (Node 22+). Lint: `npm run lint`.
- Env var names only (values are Gary's): `MONGODB_URI`, `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SENDING_ENABLED`, plus the AWS SES variables.
- Sign-in is by a code emailed to Gary. An agent never types the code.
- MachinaTechnica's notes on this app: `~/Code/machinatechnica/docs/HANDOFF.md` (read only from here).
