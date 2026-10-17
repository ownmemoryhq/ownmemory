declare namespace Cloudflare {
	interface Env {
		OAUTH_KV: KVNamespace;
		/** Google OAuth client (secrets). */
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		/** Comma-separated Google accounts allowed to connect (secret). Empty = nobody. */
		ALLOWED_EMAILS?: string;
		/** Comma-separated categories the server refuses to save, e.g. "health,finance". */
		BLOCKED_CATEGORIES?: string;
		/** "true" stops every write; reads keep working. */
		WRITES_PAUSED?: string;
		/** "d1" (one-click default: owner code + D1 database) or "drive" (Google sign-in + Drive). */
		STORAGE?: string;
		/** D1 mode: the code the owner chose at deploy time; required to connect any client. */
		OWNER_CODE?: string;
		/** D1 mode: the database holding the encrypted files. */
		DB?: D1Database;
		/** Workers AI, for meaning-based search (embeddings). Optional: without it, keyword search. */
		AI?: Ai;
		/** "off" disables meaning-based search, so memory text is never sent to Workers AI. */
		SEMANTIC_SEARCH?: string;
		/** Public origin, e.g. https://mcp.example.com. Defaults to the request's origin. */
		PUBLIC_URL?: string;
	}
}

interface Env extends Cloudflare.Env {}
