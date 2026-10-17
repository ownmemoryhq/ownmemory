// OwnMemory key handling, format version 1.
//
// This one file runs unchanged in three places: the browser (the passphrase page),
// the Worker (encrypting and decrypting memories) and Node (scripts/decrypt.mjs).
// It defines the on-Drive format, so any change here needs a new format version.
//
// Keys:
//   memory key   random 256-bit AES-GCM key; encrypts every memory file
//   passphrase   PBKDF2-SHA256 -> key that wraps the memory key (runs in the browser only)
//   recovery key random 160-bit code shown once -> HKDF-SHA256 -> key that also wraps it
//
// keyinfo.json in the user's Drive holds both wrapped copies and a check value;
// it never holds the memory key, the passphrase or the recovery key.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const FORMAT = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

const AAD_WRAP_PASSPHRASE = enc.encode("ownmemory/v1/wrap/passphrase");
const AAD_WRAP_RECOVERY = enc.encode("ownmemory/v1/wrap/recovery");
const AAD_CHECK = enc.encode("ownmemory/v1/check");
const AAD_MEMORY = enc.encode("ownmemory/v1/memory");
const CHECK_TEXT = "ownmemory key check";
const RECOVERY_BYTES = 20;
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U

/** @param {Uint8Array} bytes */
export function toB64(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

/** @param {string} str */
export function fromB64(str) {
	const s = atob(str);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

/** @param {number} n */
export function randomBytes(n) {
	return crypto.getRandomValues(new Uint8Array(n));
}

async function seal(key, bytes, aad) {
	const iv = randomBytes(12);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bytes));
	return { iv: toB64(iv), ct: toB64(ct) };
}

async function open(key, box, aad) {
	return new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv), additionalData: aad }, key, fromB64(box.ct)),
	);
}

async function passphraseKey(passphrase, salt, iterations) {
	const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromB64(salt), iterations },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

async function recoveryKey(codeBytes, salt) {
	const base = await crypto.subtle.importKey("raw", codeBytes, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: fromB64(salt), info: enc.encode("ownmemory/v1/recovery") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Imports raw memory key bytes for use with encryptMemory / decryptMemory.
 * @param {Uint8Array} bytes
 */
export function importMemoryKey(bytes) {
	if (bytes.length !== 32) throw new Error("Memory key must be 32 bytes");
	return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function asKey(key) {
	return key instanceof Uint8Array ? importMemoryKey(key) : key;
}

/** @param {Uint8Array} bytes */
export function encodeRecoveryCode(bytes) {
	let out = "";
	let value = 0;
	let bits = 0;
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
			value &= (1 << bits) - 1;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out.match(/.{1,4}/g).join("-");
}

/** @param {string} code */
export function decodeRecoveryCode(code) {
	const clean = code
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0");
	const out = [];
	let value = 0;
	let bits = 0;
	for (const ch of clean) {
		const v = BASE32.indexOf(ch);
		if (v < 0) throw new Error("The recovery key contains a character that is not allowed.");
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
			value &= (1 << bits) - 1;
		}
	}
	if (out.length !== RECOVERY_BYTES) throw new Error("The recovery key has the wrong length.");
	return new Uint8Array(out);
}

async function passphraseSection(passphrase, memoryKey) {
	const salt = toB64(randomBytes(16));
	const kek = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
	return {
		kdf: "PBKDF2-SHA256",
		iterations: PBKDF2_ITERATIONS,
		salt,
		wrapped: await seal(kek, memoryKey, AAD_WRAP_PASSPHRASE),
	};
}

/**
 * Creates a new memory key, wraps it with the passphrase and a fresh recovery key.
 * @param {string} passphrase
 * @returns {Promise<{ keyinfo: object, memoryKey: Uint8Array, recoveryCode: string }>}
 */
export async function createKeyInfo(passphrase) {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
	}
	const memoryKey = randomBytes(32);
	const recoveryBytes = randomBytes(RECOVERY_BYTES);
	const recoverySalt = toB64(randomBytes(16));
	const keyinfo = {
		ownmemory: FORMAT,
		created: new Date().toISOString(),
		passphrase: await passphraseSection(passphrase, memoryKey),
		recovery: {
			kdf: "HKDF-SHA256",
			salt: recoverySalt,
			wrapped: await seal(await recoveryKey(recoveryBytes, recoverySalt), memoryKey, AAD_WRAP_RECOVERY),
		},
		check: await seal(await importMemoryKey(memoryKey), enc.encode(CHECK_TEXT), AAD_CHECK),
	};
	return { keyinfo, memoryKey, recoveryCode: encodeRecoveryCode(recoveryBytes) };
}

/**
 * @param {any} keyinfo
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>} the memory key
 */
export async function unlockWithPassphrase(keyinfo, passphrase) {
	assertKeyInfo(keyinfo);
	const p = keyinfo.passphrase;
	const kek = await passphraseKey(passphrase, p.salt, p.iterations);
	try {
		return await open(kek, p.wrapped, AAD_WRAP_PASSPHRASE);
	} catch {
		throw new Error("That passphrase is not correct.");
	}
}

/**
 * @param {any} keyinfo
 * @param {string} code
 * @returns {Promise<Uint8Array>} the memory key
 */
export async function unlockWithRecoveryCode(keyinfo, code) {
	assertKeyInfo(keyinfo);
	const kek = await recoveryKey(decodeRecoveryCode(code), keyinfo.recovery.salt);
	try {
		return await open(kek, keyinfo.recovery.wrapped, AAD_WRAP_RECOVERY);
	} catch {
		throw new Error("That recovery key is not correct.");
	}
}

/**
 * Re-wraps the memory key under a new passphrase. Memories are not re-encrypted.
 * @param {any} keyinfo
 * @param {Uint8Array} memoryKey
 * @param {string} newPassphrase
 */
export async function changePassphrase(keyinfo, memoryKey, newPassphrase) {
	assertKeyInfo(keyinfo);
	if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
	}
	return { ...keyinfo, passphrase: await passphraseSection(newPassphrase, memoryKey) };
}

/**
 * True when memoryKey is the key this keyinfo was made for.
 * @param {any} keyinfo
 * @param {Uint8Array | CryptoKey} memoryKey
 */
export async function checkMemoryKey(keyinfo, memoryKey) {
	assertKeyInfo(keyinfo);
	try {
		const text = dec.decode(await open(await asKey(memoryKey), keyinfo.check, AAD_CHECK));
		return text === CHECK_TEXT;
	} catch {
		return false;
	}
}

/** @param {any} k */
export function assertKeyInfo(k) {
	const box = (b) => b && typeof b.iv === "string" && typeof b.ct === "string";
	const ok =
		k &&
		k.ownmemory === FORMAT &&
		k.passphrase?.kdf === "PBKDF2-SHA256" &&
		Number.isInteger(k.passphrase.iterations) &&
		k.passphrase.iterations >= 100_000 &&
		typeof k.passphrase.salt === "string" &&
		box(k.passphrase.wrapped) &&
		k.recovery?.kdf === "HKDF-SHA256" &&
		typeof k.recovery.salt === "string" &&
		box(k.recovery.wrapped) &&
		box(k.check);
	if (!ok) throw new Error("keyinfo.json is not a valid OwnMemory key file.");
}

/**
 * Encrypts one memory's text into the contents of a .omem file.
 * @param {Uint8Array | CryptoKey} memoryKey
 * @param {string} text
 */
export async function encryptMemory(memoryKey, text) {
	const box = await seal(await asKey(memoryKey), enc.encode(text), AAD_MEMORY);
	return JSON.stringify({ ownmemory: FORMAT, ...box });
}

/**
 * @param {Uint8Array | CryptoKey} memoryKey
 * @param {string} fileText contents of a .omem file
 */
export async function decryptMemory(memoryKey, fileText) {
	const box = JSON.parse(fileText);
	if (box.ownmemory !== FORMAT) throw new Error("Unknown memory file format.");
	return dec.decode(await open(await asKey(memoryKey), box, AAD_MEMORY));
}
