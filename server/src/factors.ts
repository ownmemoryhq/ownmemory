// Sign-in methods for one-click (D1) servers: passkeys, and authenticator-app codes (TOTP)
// that are always paired with the owner code. No imports from the Worker runtime, so the
// tests can run this file in Node.
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

export interface Passkey {
	/** Credential id, base64url. */
	id: string;
	/** COSE public key, base64url. */
	publicKey: string;
	counter: number;
	transports?: string[];
	/** Where it was added, e.g. "iPhone" or "Windows", to tell passkeys apart. */
	name: string;
	created: string;
	lastUsed?: string;
}

export interface Totp {
	/** Base32 secret, as the authenticator app shows it. */
	secret: string;
	created: string;
	/** The last 30-second step accepted, so a code works only once. */
	lastStep: number;
}

/** The server's sign-in methods, stored in its own D1 database. */
export interface SignInMethods {
	v: 1;
	/** Hash of the owner code at claim time; when OWNER_CODE changes, these methods are reset. */
	ownerCode: string;
	/** Random WebAuthn user handle, base64url. */
	userId: string;
	passkeys: Passkey[];
	totp?: Totp;
}

export const hasMethods = (m: SignInMethods | null): m is SignInMethods => !!m && (m.passkeys.length > 0 || !!m.totp);

// ---- base64url / base32 ----------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string) {
	const s = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, what authenticator apps expect

export function base32Encode(bytes: Uint8Array) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(text: string) {
	const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		value = (value << 5) | BASE32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

// ---- Authenticator codes (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds) -----------------------

export const TOTP_STEP = 30;

export function newTotpSecret() {
	return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** The otpauth:// link that authenticator apps read from a QR code. */
export function totpUri(secret: string, account: string) {
	const label = encodeURIComponent(`OwnMemory:${account}`);
	return `otpauth://totp/${label}?secret=${secret}&issuer=OwnMemory&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
}

export async function totpCode(secret: string, step: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(step));
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
	const offset = mac[mac.length - 1] & 0x0f;
	const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
	return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * The step a code belongs to, if it is right for now (allowing one step of clock drift either
 * way) and newer than the last code accepted; otherwise null.
 */
export async function checkTotp(secret: string, code: unknown, lastStep: number, now = Date.now()): Promise<number | null> {
	const given = typeof code === "string" ? code.replace(/\s/g, "") : "";
	if (!/^\d{6}$/.test(given)) return null;
	const current = Math.floor(now / 1000 / TOTP_STEP);
	for (const step of [current, current - 1, current + 1]) {
		if (step > lastStep && (await totpCode(secret, step)) === given) return step;
	}
	return null;
}

// ---- Passkeys (WebAuthn) ---------------------------------------------------------------------

/** The site passkeys belong to: this server's hostname and origin. */
export interface RelyingParty {
	id: string;
	origin: string;
}

export function relyingParty(origin: string): RelyingParty {
	return { id: new URL(origin).hostname, origin: new URL(origin).origin };
}

// ES256 (Apple, Google, most security keys), RS256 (some Windows Hello), EdDSA.
const ALGORITHMS = [-7, -257, -8];

export function registrationOptions(rp: RelyingParty, userId: string, existing: Passkey[]) {
	return generateRegistrationOptions({
		rpName: "OwnMemory",
		rpID: rp.id,
		userID: b64urlDecode(userId),
		userName: `owner@${rp.id}`,
		userDisplayName: `OwnMemory (${rp.id})`,
		attestationType: "none",
		excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
		authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
		supportedAlgorithmIDs: ALGORITHMS,
	});
}

export async function verifyRegistration(
	rp: RelyingParty,
	response: unknown,
	challenge: string,
	name: string,
): Promise<Passkey | null> {
	const result = await verifyRegistrationResponse({
		response: response as RegistrationResponseJSON,
		expectedChallenge: challenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		requireUserVerification: true,
		supportedAlgorithmIDs: ALGORITHMS,
	});
	if (!result.verified) return null;
	const { credential } = result.registrationInfo;
	return {
		id: credential.id,
		publicKey: b64urlEncode(credential.publicKey),
		counter: credential.counter,
		...(credential.transports?.length ? { transports: credential.transports } : {}),
		name,
		created: new Date().toISOString(),
	};
}

export function authenticationOptions(rp: RelyingParty, passkeys: Passkey[]) {
	return generateAuthenticationOptions({
		rpID: rp.id,
		allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
		userVerification: "required",
	});
}

/** The passkey that signed in, with its counter and last use updated; null if verification failed. */
export async function verifyAuthentication(
	rp: RelyingParty,
	response: unknown,
	challenge: string,
	passkeys: Passkey[],
): Promise<Passkey | null> {
	const id = (response as { id?: unknown })?.id;
	const passkey = passkeys.find((p) => p.id === id);
	if (!passkey) return null;
	const result = await verifyAuthenticationResponse({
		response: response as AuthenticationResponseJSON,
		expectedChallenge: challenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		credential: { id: passkey.id, publicKey: b64urlDecode(passkey.publicKey), counter: passkey.counter, transports: passkey.transports },
		requireUserVerification: true,
	});
	if (!result.verified) return null;
	return { ...passkey, counter: result.authenticationInfo.newCounter, lastUsed: new Date().toISOString() };
}

/** A short name for a new passkey, from the browser's User-Agent. */
export function deviceName(userAgent: string | null | undefined) {
	const ua = userAgent ?? "";
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Windows/.test(ua)) return "Windows";
	if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
	if (/CrOS/.test(ua)) return "Chromebook";
	if (/Linux/.test(ua)) return "Linux";
	return "Passkey";
}
