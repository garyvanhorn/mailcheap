# HANDOFF: mailto:bot (repo mailcheap)

mailto:bot is Gary's fork of MailCheap, the open source newsletter app (AGPL-3.0). It runs at app.mailtobot.io
(Vercel project `mailtobot`, team GVX Digital) and sends MachinaTechnica. Read `AGENTS.md` before changing code.
Upstream is `marclou/mailcheap`; this fork is `garyvanhorn/mailcheap`, default branch `main`.

## Now
- Sending goes through Resend (`EMAIL_PROVIDER=resend`). Amazon SES production access was denied on Nov 1, 2026: don't reapply. The SES code path stays in the code.
- `main` is at `074b020` (Oct 29): PRs #1 to #7 merged (branding through settings, Redis `KV_` names, first-domain fix, Resend, untracked welcome emails, dark themes in every client and Gmail iOS). No open PRs.
- Transmission 001 went out on Oct 29 from app.mailtobot.io (MachinaTechnica's newsletter). Its design is Midnight with custom colors: don't reset it.
- The dark email template is checked in Gmail web and Gmail iOS only; Outlook, Yahoo, Apple Mail, Gmail Android and iCloud are untested.
- The main checkout sits on `fix/gmail-ios-dark` (already merged). Start new work from `origin/main` in a worktree.

## Needs Gary
- Review and merge this HANDOFF PR (Nov 1 scheduled run): https://github.com/garyvanhorn/mailcheap/pull/8
- Assumed this fork keeps the AGPL source link pointing at upstream until `NEXT_PUBLIC_SOURCE_URL` is set in Vercel to `https://github.com/garyvanhorn/mailcheap`; set it if you want the fork's own link shown (no code change needed).

## Next
- Fork cosmetics: README badges, Deploy button and `SECURITY.md` still point at `marclou/mailcheap`; decide which stay as upstream credit and which point at the fork (`lib/site.js` already reads `NEXT_PUBLIC_SOURCE_URL`).
- Deliverability: README and AGENTS.md still describe sending as SES or PostShiba; add Resend to the self-hosting guide and the help center's sending articles.
- Deliverability: confirm Resend's `email.delivery_delayed` reasons carry Gmail's `421 4.7.28` so `lib/send-backoff.js` pauses on Gmail rate limits the same way it does on PostShiba (add a test with a made-up Resend event).
- Add a database name to `MONGODB_URI` in Vercel (Gary's to set) and a mailtobot.io favicon.
- Dark email: test in Outlook and Yahoo only if Gary sets up inboxes there.

## Reference
- Tests: `npm test` (Node 22+). Lint: `npm run lint`.
- Env var names only (values are Gary's): `MONGODB_URI`, `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SENDING_ENABLED`, plus the AWS SES variables.
- Sign-in is by a code emailed to Gary. An agent never types the code.
- MachinaTechnica's notes on this app: `~/Code/machinatechnica/docs/HANDOFF.md` (read only from here).
