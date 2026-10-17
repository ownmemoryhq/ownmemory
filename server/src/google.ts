// Google sign-in and the Drive calls OwnMemory makes. The drive.file scope means the
// server only ever sees files it created itself.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SCOPES = `openid email ${DRIVE_SCOPE}`;

const FOLDER_NAME = "OwnMemory";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface GoogleTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number; // epoch ms
	idToken?: string;
	scope: string;
}

/** Google said the refresh token is no longer valid: the user revoked access. */
export class GoogleAccessRevoked extends Error {}

export class DriveError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The Google client secrets; only Drive-mode servers have them. */
function googleClient(env: Env) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set");
	return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

export interface AuthorizeOptions {
	/** Ask again for just the Drive scope, for someone who signed in but left Google's Drive
	 * checkbox unticked; Google then shows a single, clear Drive screen. */
	driveOnly?: { email: string };
	/** No refresh token: the memories page only needs access while it is open. */
	online?: boolean;
}

export function googleAuthorizeUrl(
	env: Env,
	redirectUri: string,
	state: string,
	codeChallenge: string,
	{ driveOnly, online }: AuthorizeOptions = {},
) {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", googleClient(env).id);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", driveOnly ? DRIVE_SCOPE : GOOGLE_SCOPES);
	if (driveOnly) {
		url.searchParams.set("include_granted_scopes", "true");
		url.searchParams.set("login_hint", driveOnly.email);
	}
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (!online) {
		// offline + consent: always return a refresh token, so the server can keep writing.
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("prompt", "consent");
	}
	return url.href;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<GoogleTokens> {
	const client = googleClient(env);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: client.id,
			client_secret: client.secret,
			...params,
		}),
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, any>;
	if (!response.ok) {
		if (body.error === "invalid_grant") throw new GoogleAccessRevoked("Google access was revoked");
		throw new Error(`Google token request failed (${response.status} ${body.error ?? ""})`);
	}
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
		idToken: body.id_token,
		scope: String(body.scope ?? ""),
	};
}

export function exchangeCode(env: Env, code: string, verifier: string, redirectUri: string) {
	return tokenRequest(env, {
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		redirect_uri: redirectUri,
	});
}

export function refreshAccessToken(env: Env, refreshToken: string) {
	return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/**
 * Reads the ID token Google just returned over TLS from its token endpoint, which
 * Google documents as safe to use without verifying the signature.
 */
export function readIdToken(idToken: string | undefined) {
	if (!idToken) throw new Error("Google did not return an ID token");
	const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
	const claims = JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=")));
	return {
		sub: String(claims.sub),
		email: String(claims.email ?? "").toLowerCase(),
		emailVerified: claims.email_verified === true,
	};
}

export interface DriveFile {
	id: string;
	modifiedTime: string;
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class Drive {
	constructor(private readonly accessToken: string) {}

	private async call(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.accessToken}`);
		const response = await fetch(url, { ...init, headers });
		if (!response.ok) {
			// Drive error bodies never contain file contents; keep only the status.
			throw new DriveError(response.status, `Google Drive request failed (${response.status})`);
		}
		return response;
	}

	private async list(query: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const url = new URL(`${DRIVE}/files`);
			url.searchParams.set("q", query);
			url.searchParams.set("fields", "nextPageToken,files(id,modifiedTime)");
			url.searchParams.set("pageSize", "1000");
			url.searchParams.set("spaces", "drive");
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			const body = (await (await this.call(url.href)).json()) as { files: DriveFile[]; nextPageToken?: string };
			files.push(...body.files);
			pageToken = body.nextPageToken;
		} while (pageToken);
		return files;
	}

	/** The OwnMemory folder in My Drive, created on first use. */
	async ensureFolder(): Promise<string> {
		const [existing] = await this.list(
			`name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
		);
		if (existing) return existing.id;
		const response = await this.call(`${DRIVE}/files?fields=id`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ["root"] }),
		});
		return ((await response.json()) as { id: string }).id;
	}

	/** Files OwnMemory created in the folder, by their appProperties kind: "memory" or "settings". */
	listByKind(folderId: string, kind: string) {
		return this.list(
			`'${q(folderId)}' in parents and appProperties has { key='kind' and value='${q(kind)}' } and trashed = false`,
		);
	}

	/** The file if it is one of this folder's files of the given kind and not in the trash. */
	async fileInfo(fileId: string, folderId: string, kind: string): Promise<DriveFile | null> {
		try {
			const url = `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,modifiedTime,parents,trashed,appProperties`;
			const file = (await (await this.call(url)).json()) as DriveFile & {
				parents?: string[];
				trashed?: boolean;
				appProperties?: Record<string, string>;
			};
			const ok = !file.trashed && file.parents?.includes(folderId) && file.appProperties?.kind === kind;
			return ok ? { id: file.id, modifiedTime: file.modifiedTime } : null;
		} catch (error) {
			if (error instanceof DriveError && error.status === 404) return null;
			throw error;
		}
	}

	async download(fileId: string): Promise<string> {
		return (await this.call(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`)).text();
	}

	async create(folderId: string, name: string, content: string, appProperties: Record<string, string>) {
		const boundary = `ownmemory${crypto.randomUUID().replace(/-/g, "")}`;
		const metadata = { name, parents: [folderId], mimeType: "application/json", appProperties };
		const body =
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
		const response = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body,
		});
		return (await response.json()) as DriveFile;
	}

	async update(fileId: string, content: string) {
		const response = await this.call(
			`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: content },
		);
		return (await response.json()) as DriveFile;
	}

	/** Moves a file to the Drive trash; the owner can restore it for 30 days. */
	async trash(fileId: string) {
		await this.call(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ trashed: true }),
		});
	}
}
