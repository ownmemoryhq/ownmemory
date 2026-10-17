// The passphrase page. Runs in the browser only: the passphrase and the recovery key
// never leave this page; only the unwrapped memory key (and, when it changed, the new
// keyinfo.json) is posted back, over HTTPS, to be sealed into the OAuth grant.
import {
	MIN_PASSPHRASE_LENGTH,
	changePassphrase,
	createKeyInfo,
	toB64,
	unlockWithPassphrase,
	unlockWithRecoveryCode,
} from "/keys.js";
import { signIn } from "/gate.js";

const data = JSON.parse(document.getElementById("om-data").textContent);
const $ = (id) => document.getElementById(id);

function show(id) {
	for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.id !== id;
	const focus = $(id).querySelector("input");
	if (focus) focus.focus();
}

function setBusy(form, busy, label) {
	const button = form.querySelector("button[type=submit]");
	button.disabled = busy;
	if (label) button.textContent = label;
	form.querySelector(".error").textContent = "";
}

function fail(form, error, label) {
	setBusy(form, false, label);
	form.querySelector(".error").textContent = error.message || String(error);
}

function checkNewPassphrase(a, b) {
	if (a.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
	if (a !== b) throw new Error("The two passphrases do not match.");
}

function finish(mode, memoryKey, keyinfo) {
	for (const input of document.querySelectorAll("input[type=password], input[name=recovery]")) input.value = "";
	const form = $("finish-form");
	form.elements.mode.value = mode;
	form.elements.memoryKey.value = toB64(memoryKey);
	form.elements.keyinfo.value = keyinfo ? JSON.stringify(keyinfo) : "";
	form.submit();
}

$("create-form")?.addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	try {
		checkNewPassphrase(form.elements.passphrase.value, form.elements.confirm.value);
		setBusy(form, true, "Creating your key…");
		const created = await createKeyInfo(form.elements.passphrase.value);
		$("recovery-code").textContent = created.recoveryCode;
		show("recovery-panel");
		$("recovery-form").addEventListener("submit", (e) => {
			e.preventDefault();
			finish("create", created.memoryKey, created.keyinfo);
		});
	} catch (error) {
		fail(form, error, "Create key");
	}
});

$("recovery-saved")?.addEventListener("change", (event) => {
	$("recovery-continue").disabled = !event.currentTarget.checked;
});

$("copy-recovery")?.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText($("recovery-code").textContent);
		$("copy-recovery").textContent = "Copied";
	} catch {
		$("copy-recovery").textContent = "Copy failed: select the text instead";
	}
});

$("unlock-form")?.addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	try {
		setBusy(form, true, "Unlocking…");
		const memoryKey = await unlockWithPassphrase(data.keyinfo, form.elements.passphrase.value);
		finish("unlock", memoryKey);
	} catch (error) {
		fail(form, error, "Unlock");
	}
});

$("recover-form")?.addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	try {
		checkNewPassphrase(form.elements.passphrase.value, form.elements.confirm.value);
		setBusy(form, true, "Checking your recovery key…");
		const memoryKey = await unlockWithRecoveryCode(data.keyinfo, form.elements.recovery.value);
		const keyinfo = await changePassphrase(data.keyinfo, memoryKey, form.elements.passphrase.value);
		finish("recover", memoryKey, keyinfo);
	} catch (error) {
		fail(form, error, "Set new passphrase");
	}
});

// One-click servers: the sign-in step (passkey or codes) comes first; only then does the
// server send the wrapped key.
async function gate() {
	show("gate-panel");
	try {
		const result = await signIn($("gate-panel"), "/gate/connect", { handle: $("finish-form").elements.handle.value });
		data.mode = result.mode;
		data.keyinfo = result.keyinfo;
		show(result.mode === "create" ? "create-panel" : "unlock-panel");
	} catch (error) {
		$("gate-panel").replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: error.message || String(error) }));
	}
}

$("show-recover")?.addEventListener("click", () => show("recover-panel"));
$("show-unlock")?.addEventListener("click", () => show("unlock-panel"));

if (data.mode === "gate") gate();
else show(data.mode === "create" ? "create-panel" : "unlock-panel");
