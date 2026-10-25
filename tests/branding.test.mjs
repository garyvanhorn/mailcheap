import assert from "node:assert/strict";
import { test } from "node:test";
import { getEmailFrom, quoteDisplayName } from "../lib/config.js";

test("display names with punctuation are quoted for the From header", () => {
	assert.equal(quoteDisplayName("MailCheap"), "MailCheap");
	assert.equal(quoteDisplayName("mailto:bot"), '"mailto:bot"');
	assert.equal(quoteDisplayName("Acme, Inc."), '"Acme, Inc."');
	assert.equal(quoteDisplayName('Say "hi"\r\nBcc: x@example.com'), '"Say hiBcc: x@example.com"', "no quotes or line breaks get through");
});

test("the cloud sender quotes the app name", () => {
	const from = getEmailFrom({ MAILCHEAP_CLOUD: "true" });
	assert.match(from, /^(MailCheap|"[^"]+") <hello@r\.mailcheap\.ai>$/);
});

test("NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_TAGLINE and NEXT_PUBLIC_SOURCE_URL rename a server", async () => {
	const previous = { ...process.env };
	try {
		process.env.NEXT_PUBLIC_APP_NAME = "mailto:bot";
		process.env.NEXT_PUBLIC_TAGLINE = "Newsletters your agents can run.";
		process.env.NEXT_PUBLIC_SOURCE_URL = "https://github.com/example/fork";
		const config = await import(`../lib/config.js?branding=${Date.now()}`);
		const site = await import(`../lib/site.js?branding=${Date.now()}`);
		assert.equal(config.APP_NAME, "mailto:bot");
		assert.equal(config.getEmailFrom({ MAILCHEAP_CLOUD: "true" }), '"mailto:bot" <hello@r.mailcheap.ai>');
		assert.equal(site.TAGLINE, "Newsletters your agents can run.");
		assert.equal(site.SOURCE_URL, "https://github.com/example/fork");
		assert.equal(site.UPSTREAM_SOURCE_URL, "https://github.com/marclou/mailcheap");
	} finally {
		process.env = previous;
	}
});

test("without branding the server is MailCheap", async () => {
	const config = await import("../lib/config.js");
	if (!process.env.NEXT_PUBLIC_APP_NAME) assert.equal(config.APP_NAME, "MailCheap");
	assert.equal(config.UPSTREAM_NAME, "MailCheap");
});
