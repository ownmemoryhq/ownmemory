// npm run eval: starts the evaluation Worker locally, fetches its report, prints it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const config = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const dev = spawn("npx", ["wrangler", "dev", "-c", config, "--port", "8792"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));
try {
	let report;
	for (let i = 0; i < 90 && !report; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const res = await fetch("http://localhost:8792/");
			report = res.ok ? await res.json() : { status: res.status, body: await res.text() };
		} catch {}
	}
	console.log(report ? JSON.stringify(report, null, 2) : `Evaluation Worker did not start.\n${log}`);
} finally {
	dev.kill();
}
