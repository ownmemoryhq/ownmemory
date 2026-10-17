import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChoice, markNudged, newSettings, parseSettings, rampStatus } from "../src/settings.ts";

const day = (n) => new Date(Date.parse("2026-10-01T09:00:00Z") + n * 86_400_000);

test("ramp-up nudges progress once a day, then asks once complete", () => {
	let s = newSettings(day(0));
	assert.deepEqual(rampStatus(s, day(0), 3), { day: 1, nudge: "progress" });
	s = markNudged(s, day(0));
	assert.equal(rampStatus(s, day(0), 3).nudge, "none");
	assert.deepEqual(rampStatus(s, day(1), 3), { day: 2, nudge: "progress" });
	assert.equal(rampStatus(s, day(14), 25).nudge, "ask");
	assert.equal(rampStatus(s, day(14), 5).nudge, "progress"); // too few memories yet
});

test("not yet snoozes for 7 days, then asks again", () => {
	const s = applyChoice(newSettings(day(0)), "not_yet", day(15));
	assert.equal(rampStatus(s, day(16), 25).nudge, "none");
	assert.equal(rampStatus(s, day(23), 25).nudge, "ask");
});

test("keep both and OwnMemory only stop all nudges; ramp_up restarts", () => {
	for (const mode of ["keep_both", "ownmemory_only"]) {
		const s = applyChoice(newSettings(day(0)), mode, day(15));
		assert.equal(s.mode, mode);
		assert.equal(rampStatus(s, day(40), 99).nudge, "none");
	}
	const restarted = applyChoice(applyChoice(newSettings(day(0)), "keep_both", day(15)), "ramp_up", day(20));
	assert.equal(restarted.mode, "ramp_up");
	assert.deepEqual(rampStatus(restarted, day(20), 99), { day: 1, nudge: "progress" });
});

test("damaged settings fall back to a fresh ramp-up", () => {
	assert.equal(parseSettings('{"v":1,"mode":"bogus"}', day(0)).mode, "ramp_up");
	assert.equal(parseSettings('{"v":1,"mode":"keep_both","rampStart":"2026-10-01T00:00:00Z"}', day(0)).rampDays, 14);
});
