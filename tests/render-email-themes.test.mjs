import assert from "node:assert/strict";
import { test } from "node:test";
import { getConfirmationContent } from "../lib/confirmation-content.js";
import { renderEmail } from "../lib/render-email.js";

const markdown = "# Big news\n\nA [link](https://example.org).\n\n:::box\nA box\n:::\n\n> A quote";
const base = { markdown, subject: "Hi", previewText: "Preview", webUrl: "https://example.org/p/hi" };

function render(theme, options = {}) {
	return renderEmail({ ...base, newsletter: { name: "Field notes", postalAddress: "1 Main St", ...(theme && { theme }) }, ...options });
}

test("MailCheap's theme, saved or not, sends the email it always did: system fonts, no web fonts", () => {
	const plain = render(null);
	assert.equal(render({ preset: "mailcheap" }).html, plain.html);
	assert.doesNotMatch(plain.html, /@font-face|\[if mso\]/);
	assert.match(plain.html, /font-family:-apple-system,BlinkMacSystemFont,'Segoe UI'/);
	assert.match(plain.html, /<div style="margin:24px 0;padding:24px 24px 8px;border-radius:12px;background:#f4f4f5;">/);
});

test("a theme paints the email: page, text, headings, links, boxes and footer", () => {
	const { html, text } = render({ preset: "garden" }, { fontBaseUrl: "https://mail.example.com" });
	assert.match(html, /<body style="margin:0;padding:0;background:#eef1e8;background-color:#eef1e8;" bgcolor="#eef1e8">/);
	assert.match(html, /font-family:'MC DM Sans',-apple-system/);
	assert.match(html, /\.body h1, \.body h2, \.body h3 \{ line-height: 1\.3; margin: 40px 0 15px; color: #1f2a22; font-family: 'MC Fraunces',Georgia,'Times New Roman',Times,serif; font-weight: 600; letter-spacing: -0\.015em; \}/);
	assert.match(html, /\.body a \{ color: #2f6a4a; \}/);
	assert.match(html, /<div style="margin:24px 0;padding:24px 24px 4px;border-radius:16px;background:#/);
	assert.doesNotMatch(html, /background:#f4f4f5/);
	assert.match(html, /padding:40px 24px;/, "spacious spacing");
	assert.equal(text, render(null).text, "the text version doesn't change");
});

test("web fonts load from the app on screens only, and Outlook gets fonts it has", () => {
	const { html } = render({ preset: "broadsheet" }, { fontBaseUrl: "https://mail.example.com" });
	assert.match(html, /<style>\n@media screen \{ @font-face\{font-family:'MC Instrument Serif'/);
	assert.match(html, /url\(https:\/\/mail\.example\.com\/fonts\/newsreader-latin\.woff2\)/);
	assert.match(html, /<!--\[if mso\]><style>body, table, td, p, a, li, blockquote \{ font-family: Georgia,serif !important; \} h1, h2, h3 \{ font-family: Georgia,serif !important; \}<\/style><!\[endif\]-->/);
});

test("the confirmation button takes the accent, its readable label and the theme's corners", () => {
	const { html } = renderEmail({ ...getConfirmationContent({ name: "Field notes" }), newsletter: { name: "Field notes", theme: { preset: "poster" } } });
	assert.match(html, /style="display:inline-block;background:#ffd23f;color:#0a0a0a;[^"]*border-radius:0px;"/);
	const pill = renderEmail({ ...getConfirmationContent({ name: "Field notes" }), newsletter: { name: "Field notes", theme: { preset: "sunset" } } });
	assert.match(pill.html, /border-radius:999px;">Confirm my subscription<\/a>/);
});

test("editor pictures take the theme's corners; designed HTML emails keep their own look", () => {
	const rich = renderEmail({ format: "rich", html: '<p>Hi</p><img src="https://cdn.example.com/a.png" alt="">', subject: "Hi", newsletter: { name: "N", theme: { preset: "swiss" } } });
	assert.match(rich.html, /<img style="display:block;max-width:100%;height:auto;margin:24px auto;border-radius:0px;"/);
	const designed = { format: "html", html: "<html><body><p>Hi</p></body></html>", subject: "Hi" };
	assert.equal(renderEmail({ ...designed, newsletter: { name: "N", theme: { preset: "midnight" } } }).html, renderEmail({ ...designed, newsletter: { name: "N" } }).html);
});

test("a dark theme stays dark where clients drop <body> and <style> backgrounds", () => {
	const theme = { preset: "midnight", colors: { background: "#070909", text: "#e6ebe7", accent: "#ff7a5c" } };
	const { html } = renderEmail({
		format: "rich",
		html: '<h2>Signals</h2><p>See <a href="https://example.org">the spec</a> and <code>ttlMs</code>.</p><blockquote><p>End.</p></blockquote><hr>',
		subject: "Hi",
		webUrl: "https://example.org/p/hi",
		newsletter: { name: "MachinaTechnica", postalAddress: "1 Main St", theme },
	});
	assert.match(html, /<meta name="color-scheme" content="light dark">\n<meta name="supported-color-schemes" content="light dark">/);
	assert.match(html, /:root \{ color-scheme: light dark; supported-color-schemes: light dark; \}/);
	// Every layer of the page carries the color as an attribute and inline, for Gmail and Outlook.
	assert.match(html, /<body [^>]*background-color:#070909;[^>]*bgcolor="#070909" class="mc-body">/);
	assert.equal(html.match(/bgcolor="#070909"/g).length, 5, "body, outer table, its cell, the column and the content cell");
	assert.match(html, /<v:background fill="t"><v:fill type="tile" color="#070909"\/><\/v:background>/);
	assert.match(html, /<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">/);
	assert.match(html, /\[data-ogsb\] \.mc-page \{ background-color: #070909 !important; \}/);
	assert.match(html, /\[data-ogsc\] \.mc-page \{ color: #[0-9a-f]{6} !important; \}/);
	// Text colors live on the elements, not only in <style>.
	assert.match(html, /<td class="body mc-page" bgcolor="#070909" style="color:#[0-9a-f]{6};background-color:#070909;">/);
	assert.match(html, /<h2 style="color:#e6ebe7;">Signals<\/h2>/);
	assert.match(html, /<a href="https:\/\/example\.org" style="color:#[0-9a-f]{6};">the spec<\/a>/);
	assert.match(html, /<code style="color:#[0-9a-f]{6};background-color:#[0-9a-f]{6};overflow-wrap:anywhere;word-break:break-word;">ttlMs<\/code>/);
	assert.match(html, /<blockquote style="color:#[0-9a-f]{6};border-left:3px solid #[0-9a-f]{6};padding-left:16px;">/);
	assert.match(html, /<hr style="border:0;border-top:1px solid #[0-9a-f]{6};">/);
	assert.match(html, /<a href="[^"]*" style="color:#[0-9a-f]{6};text-decoration:none;">Read online<\/a>/, "a link with its own style keeps it");
});

test("a dark theme survives Gmail's iOS inversion: gradient page, blend layers around the column", () => {
	const theme = { preset: "midnight", colors: { background: "#070909", text: "#e6ebe7", accent: "#ff7a5c" } };
	const { html } = render(theme);
	// Gmail doesn't invert background images, so the outer layers carry the color as one.
	assert.equal(html.match(/background-image:linear-gradient\(#070909,#070909\);/g).length, 3, "body, outer table and its cell");
	assert.match(html, /u \+ \.mc-body \.mc-blend-screen \{ background: #000; mix-blend-mode: screen; \}/);
	assert.match(html, /u \+ \.mc-body \.mc-blend-difference \{ background: #000; mix-blend-mode: difference; \}/);
	// The column, footer included, sits inside both layers, and nothing inside them uses a background image.
	const inner = html.slice(html.indexOf('<div class="mc-blend-screen"><div class="mc-blend-difference">'), html.indexOf("</div></div>"));
	assert.ok(inner.length > 0, "the blend layers wrap the column");
	assert.match(inner, /You're receiving this/);
	assert.doesNotMatch(inner, /background-image/);
	assert.match(inner, /max-width:600px;margin:0 auto;/);
});

test("a light theme says light, and MailCheap's own theme keeps its email exactly", () => {
	const { html } = render({ preset: "garden" });
	assert.match(html, /<meta name="color-scheme" content="light">\n<meta name="supported-color-schemes" content="light">/);
	// Gmail may invert a light theme to dark; that's fine, so it gets no blend layers.
	assert.doesNotMatch(html, /mc-blend|mc-body|linear-gradient/);
	const plain = render(null).html;
	assert.doesNotMatch(plain, /bgcolor|supported-color-schemes|v:background|data-ogs|mc-page/);
	assert.match(plain, /<body style="margin:0;padding:0;background:#ffffff;">/);
});
