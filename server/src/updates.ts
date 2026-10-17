// Tells the owner when a newer OwnMemory release is out. At most twice a day the server asks
// GitHub's public API for the latest release and caches the answer in KV. The request carries
// nothing about the owner or their memories, and no OwnMemory project server is involved.
// UPDATE_CHECK="off" turns it off.
import pkg from "../package.json" with { type: "json" };

/** This server's version, from package.json. */
export const VERSION: string = pkg.version;

const LATEST_RELEASE = "https://api.github.com/repos/ownmemoryhq/ownmemory/releases/latest";
const RELEASES = "https://github.com/ownmemoryhq/ownmemory/releases";
export const UPDATING_GUIDE = "https://github.com/ownmemoryhq/ownmemory/blob/main/docs/setup.md#updating-your-server";
const CACHE_KEY = "ownmemory:latest-release";
const CACHE_TTL = 12 * 3600;
const FAILED_TTL = 3600; // GitHub unreachable or rate-limited: try again in an hour

export interface Update {
	current: string;
	latest: string;
	/** The release's page on GitHub, with what's new. */
	url: string;
}

/** Whether version a (like "0.2.10") is newer than b. */
export function newer(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] || 0;
		const y = pb[i] || 0;
		if (x !== y) return x > y;
	}
	return false;
}

interface Latest {
	tag: string | null;
	url?: string;
}

async function latestRelease(env: Env): Promise<Latest> {
	const cached = await env.OAUTH_KV.get<Latest>(CACHE_KEY, "json");
	if (cached) return cached;
	let latest: Latest = { tag: null };
	try {
		const response = await fetch(LATEST_RELEASE, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "OwnMemory-server" },
		});
		if (response.ok) {
			const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
			if (typeof release.tag_name === "string") {
				latest = { tag: release.tag_name, url: typeof release.html_url === "string" ? release.html_url : undefined };
			}
		}
	} catch {
		// Offline or blocked: no notice this time.
	}
	await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(latest), { expirationTtl: latest.tag ? CACHE_TTL : FAILED_TTL });
	return latest;
}

/** A newer release, or null when this server is current, the check is off, or GitHub didn't answer. */
export async function availableUpdate(env: Env): Promise<Update | null> {
	if (env.UPDATE_CHECK === "off") return null;
	const { tag, url } = await latestRelease(env);
	const latest = tag?.replace(/^v/, "");
	if (!latest || !/^\d+(\.\d+)*$/.test(latest) || !newer(latest, VERSION)) return null;
	return { current: VERSION, latest, url: url?.startsWith("https://github.com/") ? url : RELEASES };
}
