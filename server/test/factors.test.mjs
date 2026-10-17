import assert from "node:assert/strict";
import { test } from "node:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
	authenticationOptions,
	b64urlDecode,
	b64urlEncode,
	base32Decode,
	base32Encode,
	checkTotp,
	deviceName,
	registrationOptions,
	relyingParty,
	totpCode,
	verifyAuthentication,
	verifyRegistration,
} from "../src/factors.ts";

test("authenticator codes match RFC 6238 (SHA-1, last 6 digits)", async () => {
	const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
	assert.equal(await totpCode(secret, Math.floor(59 / 30)), "287082");
	assert.equal(await totpCode(secret, Math.floor(1111111109 / 30)), "081804");
	assert.equal(await totpCode(secret, Math.floor(1234567890 / 30)), "005924");
	assert.deepEqual(base32Decode(secret), new TextEncoder().encode("12345678901234567890"));
});

test("an authenticator code works once, within one step of clock drift", async () => {
	const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
	const now = Date.now();
	const step = Math.floor(now / 30000);
	const code = await totpCode(secret, step);
	assert.equal(await checkTotp(secret, code, 0, now), step);
	assert.equal(await checkTotp(secret, code, step, now), null, "replay refused");
	assert.equal(await checkTotp(secret, await totpCode(secret, step - 1), 0, now), step - 1, "previous step accepted");
	assert.equal(await checkTotp(secret, await totpCode(secret, step - 3), 0, now), null, "old code refused");
	assert.equal(await checkTotp(secret, "12345", 0, now), null);
	assert.equal(await checkTotp(secret, undefined, 0, now), null);
});

test("device names come from the User-Agent", () => {
	assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"), "Windows");
	assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
	assert.equal(deviceName(null), "Passkey");
});

// A software authenticator, standing in for a phone, a Mac or Windows Hello.
const enc = new TextEncoder();
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** Raw r||s from WebCrypto to the DER form WebAuthn uses. */
function derSignature(raw) {
	const int = (b) => {
		let i = 0;
		while (i < b.length - 1 && b[i] === 0) i++;
		b = b.slice(i);
		if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
		return concat(new Uint8Array([2, b.length]), b);
	};
	const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

async function authenticator(kind) {
	const params = kind === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
	const keys = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
	const cose =
		kind === "ES256"
			? new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlDecode(jwk.x)], [-3, b64urlDecode(jwk.y)]])
			: new Map([[1, 3], [3, -257], [-1, b64urlDecode(jwk.n)], [-2, b64urlDecode(jwk.e)]]);
	const credentialId = crypto.getRandomValues(new Uint8Array(16));
	let counter = 0;
	return {
		id: b64urlEncode(credentialId),
		async create(options, origin) {
			const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
			const authData = concat(
				await sha256(enc.encode(options.rp.id)),
				new Uint8Array([0x45]), // user present, user verified, credential data included
				u32(counter),
				new Uint8Array(16),
				new Uint8Array([0, credentialId.length]),
				credentialId,
				isoCBOR.encode(cose),
			);
			const attestationObject = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
			return {
				id: b64urlEncode(credentialId),
				rawId: b64urlEncode(credentialId),
				type: "public-key",
				response: { clientDataJSON: b64urlEncode(clientData), attestationObject: b64urlEncode(attestationObject), transports: ["internal"] },
				clientExtensionResults: {},
			};
		},
		async get(options, origin, { verified = true } = {}) {
			counter++;
			const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
			const authData = concat(await sha256(enc.encode(options.rpId)), new Uint8Array([verified ? 0x05 : 0x01]), u32(counter));
			const signed = concat(authData, await sha256(clientData));
			const raw = new Uint8Array(
				await crypto.subtle.sign(kind === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5", keys.privateKey, signed),
			);
			return {
				id: b64urlEncode(credentialId),
				rawId: b64urlEncode(credentialId),
				type: "public-key",
				response: {
					clientDataJSON: b64urlEncode(clientData),
					authenticatorData: b64urlEncode(authData),
					signature: b64urlEncode(kind === "ES256" ? derSignature(raw) : raw),
				},
				clientExtensionResults: {},
			};
		},
	};
}

for (const kind of ["ES256", "RS256"]) {
	test(`passkeys register and sign in (${kind}${kind === "RS256" ? ", as some Windows Hello keys" : ""})`, async () => {
		const origin = "https://ownmemory.example.workers.dev";
		const rp = relyingParty(origin);
		const userId = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
		const device = await authenticator(kind);

		const regOptions = await registrationOptions(rp, userId, []);
		assert.equal(regOptions.rp.id, "ownmemory.example.workers.dev");
		assert.ok(regOptions.pubKeyCredParams.some((p) => p.alg === (kind === "ES256" ? -7 : -257)));
		const passkey = await verifyRegistration(rp, await device.create(regOptions, origin), regOptions.challenge, "Windows");
		assert.ok(passkey);
		assert.equal(passkey.id, device.id);

		const authOptions = await authenticationOptions(rp, [passkey]);
		const signedIn = await verifyAuthentication(rp, await device.get(authOptions, origin), authOptions.challenge, [passkey]);
		assert.ok(signedIn?.lastUsed);
		assert.equal(signedIn.counter, 1);

		// Wrong challenge, other site, no user verification, unknown key: all refused.
		const again = await authenticationOptions(rp, [signedIn]);
		await assert.rejects(verifyAuthentication(rp, await device.get(again, origin), "c3RhbGUtY2hhbGxlbmdl", [signedIn]));
		await assert.rejects(verifyAuthentication(rp, await device.get(again, "https://evil.example"), again.challenge, [signedIn]));
		await assert.rejects(verifyAuthentication(rp, await device.get(again, origin, { verified: false }), again.challenge, [signedIn]));
		const stranger = await authenticator(kind);
		assert.equal(await verifyAuthentication(rp, await stranger.get(again, origin), again.challenge, [signedIn]), null);
	});
}
