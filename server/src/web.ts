// Helpers shared by the sign-in flow (auth.ts) and the memories page (memories.ts).
import { fromB64, randomBytes, toB64 } from "../public/keys.js";
import { D1Storage } from "./storage";

export function b64url(bytes: Uint8Array) {
	return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export const usesD1 = (env: Env) => env.STORAGE === "d1";

/**
 * D1: a fingerprint of the current OWNER_CODE. Sign-in methods, page sessions and Claude
 * connections record it, and stop working when the owner changes the code to regain control.
 */
/** A short label of the owner code, stored in plain sight with each Claude connection. */
export async function ownerCodeTag(env: Env) {
	return (await ownerCodeHash(env))?.slice(0, 12) ?? null;
}

export async function ownerCodeHash(env: Env) {
	const code = env.OWNER_CODE?.trim();
	return code ? b64url(await sha256(`ownmemory/owner-code:${code}`)) : null;
}


export function readCookie(request: Request, name: string) {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

/** Strict by default; "Lax" only for a cookie that must come back on a redirect from Google. */
export function cookie(name: string, value: string, maxAge: number, sameSite: "Strict" | "Lax" = "Strict") {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

export function allowedEmails(env: Env) {
	return (env.ALLOWED_EMAILS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export class UserFacingError extends Error {
	constructor(
		readonly title: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export function d1(env: Env) {
	if (!env.DB) throw new UserFacingError("This server isn't set up", "No D1 database is bound as DB.", 500);
	return new D1Storage(env.DB);
}

// Short-lived state (a sign-in in progress, a memories-page session) waits in KV, encrypted
// with a key derived from a random handle that lives only in the browser's HttpOnly cookie.
// KV alone reveals nothing.
async function sealedKeys(prefix: string, handle: string) {
	const kvKey = `ownmemory:${prefix}:${b64url(await sha256(`id:${handle}`))}`;
	const aes = await crypto.subtle.importKey("raw", await sha256(`key:${handle}`), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
	return { kvKey, aes };
}

export async function sealState(kv: KVNamespace, prefix: string, handle: string, value: unknown, ttl: number) {
	const { kvKey, aes } = await sealedKeys(prefix, handle);
	const iv = randomBytes(12);
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(value)));
	await kv.put(kvKey, JSON.stringify({ iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }), {
		expirationTtl: Math.max(60, Math.floor(ttl)),
	});
}

export async function openState<T>(kv: KVNamespace, prefix: string, handle: string): Promise<T | null> {
	const { kvKey, aes } = await sealedKeys(prefix, handle);
	const stored = await kv.get<{ iv: string; ct: string }>(kvKey, "json");
	if (!stored) return null;
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(stored.iv) }, aes, fromB64(stored.ct));
	return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function dropState(kv: KVNamespace, prefix: string, handle: string) {
	await kv.delete((await sealedKeys(prefix, handle)).kvKey);
}

export const newHandle = () => b64url(randomBytes(32));
export const randomVerifier = newHandle;

const MAX_FAILURES = 10; // per IP per hour: wrong owner codes and authenticator codes together

async function failureKey(request: Request) {
	return `ownmemory:owner-fails:${b64url(await sha256(request.headers.get("CF-Connecting-IP") ?? "unknown"))}`;
}

async function failures(env: Env, request: Request) {
	return Number((await env.OAUTH_KV.get(await failureKey(request))) ?? 0);
}

/** Counts a wrong owner code or authenticator code from this IP, for an hour. */
export async function recordFailure(env: Env, request: Request) {
	const key = await failureKey(request);
	const count = Number((await env.OAUTH_KV.get(key)) ?? 0);
	await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: 3600 });
}

/**
 * Checks the owner code, with at most MAX_FAILURES wrong tries per IP per hour. Returns an
 * error, or null when the code is right.
 */
export async function checkOwnerCode(
	env: Env,
	request: Request,
	code: unknown,
): Promise<{ status: 401 | 429 | 500; error: string } | null> {
	if (!env.OWNER_CODE || env.OWNER_CODE.trim().length < 12) {
		return {
			status: 500,
			error: "This server's owner code (OWNER_CODE) is missing or shorter than 12 characters, so nobody can connect.",
		};
	}
	if ((await failures(env, request)) >= MAX_FAILURES) {
		return { status: 429, error: "Too many wrong codes. Try again in an hour." };
	}
	const right = await sha256(env.OWNER_CODE.trim());
	const given = await sha256(typeof code === "string" ? code.trim() : "");
	if (!crypto.subtle.timingSafeEqual(right, given)) {
		await recordFailure(env, request);
		return { status: 401, error: "That owner code is not correct." };
	}
	return null;
}
