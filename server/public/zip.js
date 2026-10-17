// Builds and saves the "my memories" zip. Runs in the browser only, on text decrypted on the
// same page. Shared by the memories page and ownmemory.app/decrypt (site/public keeps a copy).
const enc = new TextEncoder();

function slug(text) {
	const s = text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return s || "memory";
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A zip with stored (uncompressed) entries: small, and needs no library. */
export function zip(entries) {
	const now = new Date();
	const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
	const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
	const parts = [];
	const central = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = enc.encode(name);
		const crc = crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0x0800, true); // UTF-8 names
		local.setUint16(10, dosTime, true);
		local.setUint16(12, dosDate, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, data.length, true);
		local.setUint32(22, data.length, true);
		local.setUint16(26, nameBytes.length, true);
		parts.push(new Uint8Array(local.buffer), nameBytes, data);

		const dir = new DataView(new ArrayBuffer(46));
		dir.setUint32(0, 0x02014b50, true);
		dir.setUint16(4, 20, true);
		dir.setUint16(6, 20, true);
		dir.setUint16(8, 0x0800, true);
		dir.setUint16(12, dosTime, true);
		dir.setUint16(14, dosDate, true);
		dir.setUint32(16, crc, true);
		dir.setUint32(20, data.length, true);
		dir.setUint32(24, data.length, true);
		dir.setUint16(28, nameBytes.length, true);
		dir.setUint32(42, offset, true);
		central.push(new Uint8Array(dir.buffer), nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const centralSize = central.reduce((n, p) => n + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/** A readable, unique file name for one memory. */
export function memoryFileName(title, id) {
	return `${slug(title)}-${id.slice(0, 8)}.md`;
}

export function download(blob) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `ownmemory-${new Date().toISOString().slice(0, 10)}.zip`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
