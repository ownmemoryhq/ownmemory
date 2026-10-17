// ownmemory.app landing page: static files in public/. The Worker redirects
// www.ownmemory.app to the apex and locks down the decrypt page; it stores nothing.

interface Env {
	ASSETS: Fetcher;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.hostname === "www.ownmemory.app") {
			url.hostname = "ownmemory.app";
			return Response.redirect(url.href, 301);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("This site accepts no submissions.", { status: 405, headers: { Allow: "GET, HEAD" } });
		}
		const response = await env.ASSETS.fetch(request);
		if (url.pathname !== "/decrypt" && url.pathname !== "/decrypt.html") return response;
		// The decrypt page handles a passphrase and decrypted memories: it may load only its own
		// files, and may not send anything anywhere (connect-src, form-action 'none').
		const headers = new Headers(response.headers);
		headers.set(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
		);
		headers.set("Referrer-Policy", "no-referrer");
		headers.set("X-Frame-Options", "DENY");
		return new Response(response.body, { status: response.status, headers });
	},
} satisfies ExportedHandler<Env>;
