// The user's memory mode and ramp-up state. Stored encrypted in their Drive like a memory,
// so the server keeps no state of its own. No imports: the tests load this file directly.

export type Mode = "ramp_up" | "ownmemory_only" | "keep_both";

/** What the user answered when asked how to use OwnMemory alongside Claude's memory. */
export type Choice = Mode | "not_yet";

export interface Settings {
	v: 1;
	mode: Mode;
	rampStart: string; // ISO date-time
	rampDays: number;
	snoozeUntil?: string; // ISO date-time; no reminders before this
	lastNudge?: string; // YYYY-MM-DD of the last progress line or question
	lastCatchUp?: string; // YYYY-MM-DD of the last request to copy over built-in memories
	updateNotified?: string; // the newest release Claude has already told the user about
}

export const RAMP_DAYS = 14;
export const RAMP_MIN_MEMORIES = 20;
export const SNOOZE_DAYS = 7;
const DAY = 86_400_000;

export function newSettings(now: Date): Settings {
	return { v: 1, mode: "ramp_up", rampStart: now.toISOString(), rampDays: RAMP_DAYS };
}

export function parseSettings(text: string, now: Date): Settings {
	const s = JSON.parse(text);
	const modes: Mode[] = ["ramp_up", "ownmemory_only", "keep_both"];
	if (s?.v !== 1 || !modes.includes(s.mode) || typeof s.rampStart !== "string") return newSettings(now);
	return { ...s, rampDays: Number.isInteger(s.rampDays) && s.rampDays > 0 ? s.rampDays : RAMP_DAYS };
}

export interface RampStatus {
	day: number;
	/** progress: mention how ramp-up is going. ask: ask the user to choose a mode. */
	nudge: "none" | "progress" | "ask";
}

export function rampStatus(s: Settings, now: Date, memoryCount: number): RampStatus {
	const day = Math.max(1, Math.floor((now.getTime() - Date.parse(s.rampStart)) / DAY) + 1);
	if (s.mode !== "ramp_up") return { day, nudge: "none" };
	if (s.lastNudge === now.toISOString().slice(0, 10)) return { day, nudge: "none" }; // once a day
	if (s.snoozeUntil && now.getTime() < Date.parse(s.snoozeUntil)) return { day, nudge: "none" };
	const done = day > s.rampDays && memoryCount >= RAMP_MIN_MEMORIES;
	return { day, nudge: done || s.snoozeUntil ? "ask" : "progress" };
}

export function markNudged(s: Settings, now: Date): Settings {
	return { ...s, lastNudge: now.toISOString().slice(0, 10) };
}

/**
 * Whether to ask Claude to copy its built-in memories over today, catching any fact it saved
 * only there. Once a day, while Claude's memory is on and OwnMemory already holds memories
 * (an empty one gets an offer to import instead).
 */
export function catchUpDue(s: Settings, now: Date, memoryCount: number): boolean {
	return s.mode !== "ownmemory_only" && memoryCount > 0 && s.lastCatchUp !== now.toISOString().slice(0, 10);
}

export function markCaughtUp(s: Settings, now: Date): Settings {
	return { ...s, lastCatchUp: now.toISOString().slice(0, 10) };
}

export function applyChoice(s: Settings, choice: Choice, now: Date): Settings {
	switch (choice) {
		case "not_yet":
			return { ...s, mode: "ramp_up", snoozeUntil: new Date(now.getTime() + SNOOZE_DAYS * DAY).toISOString() };
		case "ramp_up":
			return { v: 1, mode: "ramp_up", rampStart: now.toISOString(), rampDays: s.rampDays || RAMP_DAYS };
		default:
			return { ...s, mode: choice, snoozeUntil: undefined };
	}
}
