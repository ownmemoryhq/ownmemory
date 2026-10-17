// The plain text inside each encrypted .omem file: Markdown with front matter, so a
// decrypted memory is readable and portable on its own. Values are JSON strings, which
// are also valid YAML.
//
// Like keys.js, this file runs unchanged in the browser (the memories page), the Worker and
// Node (tests), so every place that reads or writes a memory agrees on the format.

export const CATEGORIES = /** @type {const} */ ([
	"profile",
	"preference",
	"work",
	"project",
	"relationship",
	"health",
	"finance",
	"other",
]);

/** How many earlier versions a memory keeps. */
export const HISTORY_LIMIT = 10;

const KEYS = /** @type {const} */ (["title", "category", "source", "created", "updated"]);

/**
 * @param {{ title: string, category: string, content: string, source: string, created: string, updated: string, history?: { content: string, until: string }[] }} m
 */
export function toMarkdown(m) {
	const lines = KEYS.map((k) => `${k}: ${JSON.stringify(m[k])}`);
	if (m.history?.length) lines.push(`history: ${JSON.stringify(m.history)}`);
	return `---\n${lines.join("\n")}\n---\n\n${m.content.trim()}\n`;
}

/**
 * @param {string} id
 * @param {string} text
 */
export function fromMarkdown(id, text) {
	const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
	if (!match) throw new Error("Memory is missing its front matter");
	/** @type {Record<string, any>} */
	const fields = {};
	for (const line of match[1].split("\n")) {
		const at = line.indexOf(":");
		if (at < 0) continue;
		fields[line.slice(0, at).trim()] = JSON.parse(line.slice(at + 1).trim());
	}
	const category = /** @type {readonly string[]} */ (CATEGORIES).includes(fields.category) ? fields.category : "other";
	return {
		id,
		title: String(fields.title ?? ""),
		category: /** @type {(typeof CATEGORIES)[number]} */ (category),
		content: match[2].trim(),
		source: String(fields.source ?? ""),
		created: String(fields.created ?? ""),
		updated: String(fields.updated ?? fields.created ?? ""),
		.../** @type {{ history?: { content: string, until: string }[] }} */ (
			Array.isArray(fields.history) && fields.history.length ? { history: fields.history } : {}
		),
	};
}

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\b(?:password|passwd|passcode|pin)\s*(?:is|[:=])\s*\S+/i,
	/(?:密码|口令)\s*(?:是|[:：=])\s*\S+/,
	/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // card numbers
];

/**
 * Hard rule: never store credentials or card numbers, whoever is writing.
 * @param {string} text
 */
export function looksLikeSecret(text) {
	return SECRET_PATTERNS.some((p) => p.test(text));
}
