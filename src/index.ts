/**
 * Cloudflare Workers — Docker Registry Mirror Proxy
 *
 * Routes requests to an upstream registry based on the request Host header,
 * enforces a client User-Agent allow-list, speaks the Docker Registry V2
 * protocol (including Bearer token negotiation and transparent CDN redirect
 * following), and never caches any data.
 *
 * The apex domain is provided via the `DOMAIN` environment variable (see
 * wrangler.jsonc `vars`). Subdomain prefixes and their upstream registries are
 * hardcoded below; the full host is built as `<prefix>.${DOMAIN}` at request
 * time. No other environment variables are used.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Subdomain prefix → upstream registry origin. The prefix is joined with the
 * `DOMAIN` env var to form the served host (e.g. `docker.${DOMAIN}`).
 *
 * Only client-facing pull endpoints are exposed. Internal hosts reached via
 * redirect during a Docker Hub pull (auth.docker.io, production.cloudfront
 * .docker.com) are followed transparently by the worker and are NOT listed.
 *
 * | prefix     | upstream                     |
 * |------------|------------------------------|
 * | docker     | registry-1.docker.io         |
 * | quay       | quay.io                      |
 * | gcr        | gcr.io                       |
 * | ghcr       | ghcr.io                      |
 * | k8s        | registry.k8s.io              |
 * | nvcr       | nvcr.io                      |
 * | cloudsmith | docker.cloudsmith.io         |
 * | ecr        | public.ecr.aws               |
 */
const UPSTREAM_PREFIXES: ReadonlyArray<[string, string]> = [
	["docker", "https://registry-1.docker.io"],
	["quay", "https://quay.io"],
	["gcr", "https://gcr.io"],
	["ghcr", "https://ghcr.io"],
	["k8s", "https://registry.k8s.io"],
	["nvcr", "https://nvcr.io"],
	["cloudsmith", "https://docker.cloudsmith.io"],
	["ecr", "https://public.ecr.aws"],
];

/** Build the host→origin map for the given apex domain. */
function buildUpstreamMap(domain: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const [prefix, origin] of UPSTREAM_PREFIXES) {
		map.set(`${prefix}.${domain}`, origin);
	}
	return map;
}

/** Upstream origin for Docker Hub (needs the library/ prefix rewrite). */
const DOCKER_HUB_ORIGIN = "https://registry-1.docker.io";

/**
 * User-Agent allow-list. Matched case-insensitively as substrings, so a UA
 * like "docker/27.0" or "containerd/v1.7.0" is accepted.
 *
 * `containers/` covers clients built on github.com/containers/image (podman,
 * skopeo, buildah, …), whose UA looks like "containers/5.29.2
 * (github.com/containers/image)" rather than "podman/<ver>".
 */
const ALLOWED_UA_TOKENS: ReadonlyArray<string> = [
	"docker/",
	"containerd/",
	"cri-o/",
	"podman/",
	"containers/",
	"buildkit/",
	"skopeo/",
	"crane/",
	"regctl/",
	"harbor/",
	"nexus/",
	"sonatype/",
	"portus/",
];

/** Maximum number of HTTP redirects to follow transparently. */
const MAX_REDIRECTS = 5;

/** Request headers forwarded from the client to the upstream registry. */
const FORWARDED_REQUEST_HEADERS: ReadonlyArray<string> = [
	"accept",
	"authorization",
	"user-agent",
	"if-none-match",
	"if-modified-since",
	"range",
];

/** Anti-cache headers applied to every response leaving the worker. */
const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-cache, no-store, must-revalidate",
	pragma: "no-cache",
	expires: "0",
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class TooManyRedirectsError extends Error {
	constructor() {
		super("too many redirects");
		this.name = "TooManyRedirectsError";
	}
}

class TokenAcquisitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenAcquisitionError";
	}
}

// ---------------------------------------------------------------------------
// In-memory Bearer token cache (per-isolate, best-effort)
// ---------------------------------------------------------------------------

interface TokenCacheEntry {
	token: string;
	expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSON error response with anti-cache headers. */
function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...NO_CACHE_HEADERS,
		},
	});
}

/** Case-insensitive User-Agent allow-list check. Missing UA → rejected. */
function isAllowedUserAgent(userAgent: string | null): boolean {
	if (!userAgent) return false;
	const lower = userAgent.toLowerCase();
	return ALLOWED_UA_TOKENS.some((token) => lower.includes(token));
}

/**
 * For Docker Hub, official images are addressed without a namespace
 * (`nginx` instead of `library/nginx`). Rewrite single-component names so the
 * upstream request resolves correctly. Already-namespaced names are left
 * untouched.
 */
function rewritePath(upstream: string, path: string): string {
	if (upstream !== DOCKER_HUB_ORIGIN) return path;
	// Match /v2/<name>/<resource>/... where <name> is a single path segment.
	const match = path.match(/^\/v2\/([^/]+)\/(manifests|blobs|tags|referrers)\//);
	if (match && !match[1].includes("/")) {
		return `/v2/library/${path.slice("/v2/".length)}`;
	}
	return path;
}

/** Parse a `WWW-Authenticate: Bearer ...` challenge into a key/value map. */
function parseBearerChallenge(header: string): {
	realm?: string;
	service?: string;
	scope?: string;
} | null {
	const match = header.match(/^Bearer\s+(.*)$/i);
	if (!match) return null;
	const params: { realm?: string; service?: string; scope?: string } = {};
	const re = /(\w+)="([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(match[1])) !== null) {
		const key = m[1].toLowerCase();
		if (key === "realm" || key === "service" || key === "scope") {
			params[key] = m[2];
		}
	}
	return params;
}

/**
 * Fetch a Bearer token from the auth realm, using a small in-memory cache keyed
 * by `service|scope`. Throws `TokenAcquisitionError` on failure.
 */
async function getBearerToken(
	realm: string,
	service?: string,
	scope?: string,
): Promise<string> {
	const cacheKey = `${service ?? ""}|${scope ?? ""}`;
	const now = Date.now();

	const cached = tokenCache.get(cacheKey);
	// Refresh a little ahead of expiry to avoid serving stale tokens.
	if (cached && cached.expiresAt > now + 5_000) {
		return cached.token;
	}

	const params = new URLSearchParams();
	if (service) params.set("service", service);
	if (scope) params.set("scope", scope);

	const tokenUrl = `${realm}${realm.includes("?") ? "&" : "?"}${params.toString()}`;
	let res: Response;
	try {
		res = await fetch(tokenUrl, {
			headers: { accept: "application/json" },
			redirect: "follow",
		});
	} catch (err) {
		throw new TokenAcquisitionError(
			`token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!res.ok) {
		throw new TokenAcquisitionError(`token endpoint returned ${res.status}`);
	}

	const data = (await res.json()) as {
		token?: string;
		access_token?: string;
		expires_in?: number;
	};
	const token = data.token ?? data.access_token;
	if (!token) {
		throw new TokenAcquisitionError("token endpoint returned no token");
	}

	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 60;
	// Cap cache lifetime; honor the server's expiry but never trust it blindly.
	const ttlMs = Math.min(Math.max(expiresIn, 10), 3600) * 1000;
	tokenCache.set(cacheKey, { token, expiresAt: now + ttlMs });
	return token;
}

/** Build the set of headers to forward to the upstream registry. */
function buildUpstreamHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

/**
 * Fetch a URL following 301/302/303/307/308 redirects manually (so we can drop
 * credentials on cross-host hops and apply our own caching policy on the final
 * response). Throws `TooManyRedirectsError` past the limit.
 */
async function fetchFollowingRedirects(
	url: string,
	headers: Headers,
	method: string,
	depth = 0,
): Promise<Response> {
	if (depth > MAX_REDIRECTS) {
		throw new TooManyRedirectsError();
	}

	const res = await fetch(url, { method, headers, redirect: "manual" });

	if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
		const location = res.headers.get("location");
		if (!location) return res;

		const nextUrl = new URL(location, url).href;
		const nextHeaders = new Headers(headers);

		// CDN redirect targets (e.g. production.cloudflare.docker.com) are
		// pre-authenticated via the signed Location URL; never leak the
		// registry Bearer token to a different host.
		if (new URL(nextUrl).host !== new URL(url).host) {
			nextHeaders.delete("authorization");
		}

		// 303 See Other always switches to GET with no body.
		const nextMethod = res.status === 303 ? "GET" : method;

		// Discard the redirect response body before re-fetching.
		try {
			await res.body?.cancel();
		} catch {
			/* ignore */
		}

		return fetchFollowingRedirects(nextUrl, nextHeaders, nextMethod, depth + 1);
	}

	return res;
}

/** Re-apply anti-cache headers to a response, preserving everything else. */
function applyNoCache(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.delete("cache-control");
	headers.delete("pragma");
	headers.delete("expires");
	for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

/**
 * Proxy a single V2 request to the upstream registry, negotiating a Bearer
 * token if the upstream issues a 401 challenge.
 */
async function proxyToUpstream(
	request: Request,
	upstream: string,
	path: string,
): Promise<Response> {
	const url = `${upstream}${path}`;
	const headers = buildUpstreamHeaders(request);
	const method = request.method;

	let res = await fetchFollowingRedirects(url, headers, method);

	// Handle the V2 Bearer auth challenge: fetch a token and retry once.
	if (res.status === 401) {
		const challenge = res.headers.get("www-authenticate");
		if (challenge) {
			const params = parseBearerChallenge(challenge);
			if (params?.realm) {
				try {
					const token = await getBearerToken(params.realm, params.service, params.scope);
					headers.set("authorization", `Bearer ${token}`);
				} catch (err) {
					// Surface token failures so the entry handler can map to 500.
					throw err;
				} finally {
					try {
						await res.body?.cancel();
					} catch {
						/* ignore */
					}
				}
				res = await fetchFollowingRedirects(url, headers, method);
			}
		}
	}

	return applyNoCache(res);
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Prefer the Host header (always set by the Workers runtime in prod);
		// fall back to the URL hostname when it's absent (e.g. in tests).
		const host = (
			request.headers.get("host") ?? new URL(request.url).hostname
		)
			.split(":")[0]
			.toLowerCase();
		const upstream = buildUpstreamMap(env.DOMAIN).get(host);

		// Unknown host → 404.
		if (!upstream) {
			return jsonError(404, "Unknown registry");
		}

		// Invalid / missing client User-Agent → 400.
		if (!isAllowedUserAgent(request.headers.get("user-agent"))) {
			return jsonError(400, "Invalid User-Agent");
		}

		// Only the V2 API surface is proxied.
		const { pathname, search } = new URL(request.url);
		if (pathname !== "/v2" && !pathname.startsWith("/v2/")) {
			return jsonError(404, "Not Found");
		}

		try {
			const path = rewritePath(upstream, `${pathname}${search}`);
			return await proxyToUpstream(request, upstream, path);
		} catch (err) {
			if (err instanceof TooManyRedirectsError) {
				return jsonError(502, "Too many redirects");
			}
			if (err instanceof TokenAcquisitionError) {
				console.error("token acquisition failed:", err.message);
				return jsonError(500, "Token acquisition failed");
			}
			console.error("upstream fetch failed:", err);
			return jsonError(504, "Gateway Timeout");
		}
	},
} satisfies ExportedHandler<Env>;
