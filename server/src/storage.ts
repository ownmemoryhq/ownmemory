// Where encrypted files live. Every backend stores the same opaque files (memories, the
// settings file, the wrapped key), so the server never depends on one provider and the
// customer can choose, or move, their storage.
import { Drive } from "./google";

/** "auth": the sign-in methods of a one-click server (D1 only; never in Drive). */
export type FileKind = "memory" | "settings" | "keyinfo" | "index" | "auth";

export interface FileRef {
	id: string;
	modifiedTime: string;
}

export interface Storage {
	list(kind: FileKind): Promise<FileRef[]>;
	read(id: string): Promise<string>;
	/** The file if it exists, is of this kind and is not deleted. */
	find(id: string, kind: FileKind): Promise<FileRef | null>;
	create(kind: FileKind, name: string, body: string): Promise<FileRef>;
	update(id: string, body: string): Promise<FileRef>;
	/** Deletes the file; backends with a trash move it there. */
	remove(id: string): Promise<void>;
}

/** Files in the customer's Google Drive, in the OwnMemory folder. */
export class DriveStorage implements Storage {
	constructor(
		private readonly drive: Drive,
		private readonly folderId: string,
	) {}

	list(kind: FileKind) {
		return this.drive.listByKind(this.folderId, kind);
	}

	read(id: string) {
		return this.drive.download(id);
	}

	find(id: string, kind: FileKind) {
		return this.drive.fileInfo(id, this.folderId, kind);
	}

	create(kind: FileKind, name: string, body: string) {
		return this.drive.create(this.folderId, name, body, { kind });
	}

	update(id: string, body: string) {
		return this.drive.update(id, body);
	}

	remove(id: string) {
		return this.drive.trash(id);
	}
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	body TEXT NOT NULL,
	modified TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0
)`;
const ready = new WeakSet<D1Database>();

/**
 * Files in a D1 database in the customer's own Cloudflare account: the one-click default,
 * created by the deploy button, free, and no payment method needed. Deleted files are kept
 * for 30 days, like a trash.
 */
export class D1Storage implements Storage {
	constructor(private readonly db: D1Database) {}

	private async init() {
		if (ready.has(this.db)) return;
		await this.db.prepare(SCHEMA).run();
		await this.db.prepare("CREATE INDEX IF NOT EXISTS files_kind ON files (kind, deleted)").run();
		const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
		await this.db.prepare("DELETE FROM files WHERE deleted = 1 AND modified < ?").bind(cutoff).run();
		ready.add(this.db);
	}

	async list(kind: FileKind) {
		await this.init();
		const { results } = await this.db
			.prepare("SELECT id, modified FROM files WHERE kind = ? AND deleted = 0")
			.bind(kind)
			.all<{ id: string; modified: string }>();
		return results.map((r) => ({ id: r.id, modifiedTime: r.modified }));
	}

	async read(id: string) {
		await this.init();
		const row = await this.db.prepare("SELECT body FROM files WHERE id = ?").bind(id).first<{ body: string }>();
		if (!row) throw new Error("File not found");
		return row.body;
	}

	async find(id: string, kind: FileKind) {
		await this.init();
		const row = await this.db
			.prepare("SELECT id, modified FROM files WHERE id = ? AND kind = ? AND deleted = 0")
			.bind(id, kind)
			.first<{ id: string; modified: string }>();
		return row ? { id: row.id, modifiedTime: row.modified } : null;
	}

	async create(kind: FileKind, name: string, body: string) {
		await this.init();
		const id = crypto.randomUUID().replace(/-/g, "");
		const modified = new Date().toISOString();
		await this.db
			.prepare("INSERT INTO files (id, kind, name, body, modified) VALUES (?, ?, ?, ?, ?)")
			.bind(id, kind, name, body, modified)
			.run();
		return { id, modifiedTime: modified };
	}

	async update(id: string, body: string) {
		await this.init();
		const modified = new Date().toISOString();
		await this.db.prepare("UPDATE files SET body = ?, modified = ? WHERE id = ?").bind(body, modified, id).run();
		return { id, modifiedTime: modified };
	}

	async remove(id: string) {
		await this.init();
		const modified = new Date().toISOString();
		await this.db.prepare("UPDATE files SET deleted = 1, modified = ? WHERE id = ?").bind(modified, id).run();
	}
}

/** The wrapped memory key (keyinfo.json), if this storage has one yet. */
export async function readKeyInfo(storage: Storage): Promise<{ id: string; keyinfo: unknown } | null> {
	const [file] = await storage.list("keyinfo");
	return file ? { id: file.id, keyinfo: JSON.parse(await storage.read(file.id)) } : null;
}

export async function writeKeyInfo(storage: Storage, keyinfo: unknown, existingId?: string) {
	const body = JSON.stringify(keyinfo, null, 2);
	return existingId ? storage.update(existingId, body) : storage.create("keyinfo", "keyinfo.json", body);
}
