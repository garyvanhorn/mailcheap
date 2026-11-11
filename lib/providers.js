const DOMAINS = {
	gmail: ["gmail.com", "googlemail.com"],
	outlook: [
		"outlook.com",
		"hotmail.com",
		"live.com",
		"msn.com",
		"hotmail.co.uk",
		"hotmail.fr",
		"live.fr",
		"outlook.fr",
	],
	yahoo: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.fr", "yahoo.co.uk", "aol.com"],
	icloud: ["icloud.com", "me.com", "mac.com"],
	proton: ["proton.me", "protonmail.com", "pm.me"],
};

export const GMAIL_DOMAINS = DOMAINS.gmail;

const PROVIDER_BY_DOMAIN = new Map(
	Object.entries(DOMAINS).flatMap(([provider, domains]) => domains.map((domain) => [domain, provider]))
);

export const PROVIDER_DOMAINS = Object.fromEntries(
	Object.entries(DOMAINS).map(([provider, domains]) => [provider, domains[0]])
);

export const PROVIDER_LABELS = {
	gmail: "Gmail",
	outlook: "Outlook",
	yahoo: "Yahoo",
	icloud: "iCloud",
	proton: "Proton",
	other: "Other",
};

export function mailboxProvider(email) {
	const domain = String(email ?? "").split("@")[1]?.toLowerCase().trim();
	return PROVIDER_BY_DOMAIN.get(domain) || "other";
}
