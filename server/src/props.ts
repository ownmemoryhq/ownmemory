/**
 * What the OAuth grant carries. The library encrypts it with a key only the holder of
 * Claude's token can unwrap, so none of this is readable from storage at rest.
 */
export interface Props {
	/** Which backend holds the memories: "drive" (Google sign-in) or "d1" (owner code). */
	storage: "drive" | "d1";
	email: string;
	sub: string;
	/** D1: the owner code's fingerprint at sign-in; changing OWNER_CODE ends the connection. */
	ownerCode?: string | null;
	/** The unwrapped memory key, base64. Exists on the server only here. */
	memoryKey: string;
	/** Drive only. */
	folderId?: string;
	google?: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
	};
	[key: string]: unknown;
}
