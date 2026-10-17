import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { AuthHandler } from "./auth";
import { GoogleAccessRevoked, refreshAccessToken } from "./google";
import type { Props } from "./props";
import { createServer } from "./tools";
import { ownerCodeHash } from "./web";

// Stateless MCP: no Durable Object, so the grant's props (which hold the memory key)
// are never written to storage; they exist only while a request runs.
const mcp = createMcpHandler(createServer, { route: "/mcp" });

function buildProvider(origin: string) {
	return new OAuthProvider<Env>({
		apiRoute: "/mcp",
		apiHandler: { fetch: (request, env, ctx) => mcp(request, env, ctx) },
		defaultHandler: AuthHandler as unknown as ExportedHandler<Env>,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		clientIdMetadataDocumentEnabled: true,
		accessTokenTTL: 3600,
		resourceMetadata: { resource: `${origin}/mcp`, resource_name: "OwnMemory" },
		// Keep the Google access token in the grant fresh whenever Claude refreshes its token.
		tokenExchangeCallback: async ({ grantType, props, env }) => {
			const current = props as Props;
			if (grantType !== "refresh_token") return;
			if (current.storage === "d1") {
				// The owner changed OWNER_CODE to regain control: end connections made before.
				if (current.ownerCode !== (await ownerCodeHash(env))) {
					throw new OAuthError("invalid_grant", { description: "The server's owner code changed; connect again" });
				}
				return; // D1 grants hold no Google token
			}
			if (!current.google) return;
			try {
				const google = await refreshAccessToken(env, current.google.refreshToken);
				return {
					newProps: {
						...current,
						google: { ...current.google, accessToken: google.accessToken, expiresAt: google.expiresAt },
					},
					accessTokenTTL: 3600,
				};
			} catch (error) {
				if (error instanceof GoogleAccessRevoked) {
					// Revokes this grant, and with it the server's only copy of the memory key.
					throw new OAuthError("invalid_grant", { description: "Google access was revoked" });
				}
				throw new OAuthError("temporarily_unavailable", { description: "Google is unavailable", statusCode: 503 });
			}
		},
	});
}

let provider: OAuthProvider<Env> | undefined;

export default {
	fetch(request, env, ctx) {
		provider ??= buildProvider((env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, ""));
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
