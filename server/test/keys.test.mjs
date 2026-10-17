import assert from "node:assert/strict";
import { test } from "node:test";
import {
	changePassphrase,
	checkMemoryKey,
	createKeyInfo,
	decodeRecoveryCode,
	decryptMemory,
	encodeRecoveryCode,
	encryptMemory,
	randomBytes,
	unlockWithPassphrase,
	unlockWithRecoveryCode,
} from "../public/keys.js";

const PASS = "correct horse battery staple";

test("passphrase and recovery key both unlock the same memory key", async () => {
	const { keyinfo, memoryKey, recoveryCode } = await createKeyInfo(PASS);
	assert.deepEqual(await unlockWithPassphrase(keyinfo, PASS), memoryKey);
	assert.deepEqual(await unlockWithRecoveryCode(keyinfo, recoveryCode.toLowerCase()), memoryKey);
	assert.equal(await checkMemoryKey(keyinfo, memoryKey), true);
	assert.equal(await checkMemoryKey(keyinfo, randomBytes(32)), false);
	assert.doesNotMatch(JSON.stringify(keyinfo), new RegExp(PASS));
});

test("wrong passphrase and wrong recovery key are rejected", async () => {
	const { keyinfo } = await createKeyInfo(PASS);
	await assert.rejects(unlockWithPassphrase(keyinfo, "not the passphrase"), /not correct/);
	await assert.rejects(unlockWithRecoveryCode(keyinfo, encodeRecoveryCode(randomBytes(20))), /not correct/);
});

test("short passphrases are refused", async () => {
	await assert.rejects(createKeyInfo("short"), /at least/);
});

test("changing the passphrase keeps the memory key and the recovery key", async () => {
	const { keyinfo, memoryKey, recoveryCode } = await createKeyInfo(PASS);
	const next = await changePassphrase(keyinfo, memoryKey, "a brand new passphrase");
	assert.deepEqual(await unlockWithPassphrase(next, "a brand new passphrase"), memoryKey);
	await assert.rejects(unlockWithPassphrase(next, PASS));
	assert.deepEqual(await unlockWithRecoveryCode(next, recoveryCode), memoryKey);
});

test("memories round-trip and are bound to their key", async () => {
	const { memoryKey } = await createKeyInfo(PASS);
	const text = "---\ntitle: \"Tea\"\n---\n\n喜欢喝乌龙茶 and dislikes coffee";
	const file = await encryptMemory(memoryKey, text);
	assert.doesNotMatch(file, /乌龙|coffee/);
	assert.equal(await decryptMemory(memoryKey, file), text);
	await assert.rejects(decryptMemory(randomBytes(32), file));
});

test("recovery codes survive formatting and look-alike characters", () => {
	const bytes = randomBytes(20);
	const code = encodeRecoveryCode(bytes);
	assert.match(code, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
	assert.deepEqual(decodeRecoveryCode(code.replace(/-/g, " ").toLowerCase()), bytes);
	assert.deepEqual(decodeRecoveryCode(code.replace(/0/g, "O").replace(/1/g, "l")), bytes);
	assert.throws(() => decodeRecoveryCode("ABCD"), /wrong length/);
});
