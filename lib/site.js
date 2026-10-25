import { APP_NAME } from "./config.js";

// The AGPL asks a server to offer its users the code it runs: a fork points this at its own repository.
export const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL?.trim() || "https://github.com/marclou/mailcheap";
export const UPSTREAM_SOURCE_URL = "https://github.com/marclou/mailcheap";

export const TAGLINE = process.env.NEXT_PUBLIC_TAGLINE?.trim() || "The affordable newsletter for the agentic era";

// Pages leave openGraph to the public layout: a page's openGraph would replace the layout's, share image
// included. Social cards take the page's title and description from these, and "./" resolves to each page's own
// address.
export const SITE_OPEN_GRAPH = { type: "website", siteName: APP_NAME, locale: "en_US", url: "./" };

export function getPageMetadata({ title, description, path }) {
	return { title, description, alternates: { canonical: path } };
}
