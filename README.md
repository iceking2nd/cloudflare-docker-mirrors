# Cloudflare Workers — Docker Registry Mirror

A transparent **Docker Registry V2** mirror proxy running on Cloudflare Workers.

It routes by request `Host` to an upstream registry, enforces a client
User-Agent allow-list, speaks the V2 protocol (Bearer token negotiation +
transparent CDN redirect following), and caches nothing. Zero runtime
dependencies — native Web API only.

## Features

- **Multi-registry mirror** behind a single apex domain, one subdomain per
  upstream registry.
- **Transparent V2 protocol** — handles Bearer token negotiation (`WWW-
  Authenticate` challenge → token cache → retry) and follows signed CDN
  redirects (e.g. Docker Hub → `production.cloudflare.docker.com`), dropping
  credentials on cross-host hops.
- **Client gate** — only allow-listed container client User-Agents pass
  (`docker/`, `containerd/`, `podman/`, `skopeo/`, …); everything else gets
  `400`.
- **No caching** — every response is forced `no-cache, no-store,
  must-revalidate`; no Cache API, no stored manifests/layer data.
- **Zero dependencies**, TypeScript (`strict: true`), `nodejs_compat` enabled.

## Supported Registries

Only client-facing pull endpoints are exposed. Internal hosts reached via
redirect during a Docker Hub pull (`auth.docker.io`,
`production.cloudflare.docker.com`) are followed transparently by the worker
and are **not** listed.

| Subdomain             | Upstream                     |
|-----------------------|------------------------------|
| `docker.{DOMAIN}`     | `registry-1.docker.io`       |
| `quay.{DOMAIN}`       | `quay.io`                    |
| `gcr.{DOMAIN}`        | `gcr.io`                     |
| `ghcr.{DOMAIN}`       | `ghcr.io`                    |
| `k8s.{DOMAIN}`        | `registry.k8s.io`            |
| `nvcr.{DOMAIN}`       | `nvcr.io`                    |
| `cloudsmith.{DOMAIN}` | `docker.cloudsmith.io`       |
| `ecr.{DOMAIN}`        | `public.ecr.aws`             |

Unknown host → `404 {"error":"Unknown registry"}`.

## Configuration

The apex domain is the **`DOMAIN`** environment variable, set in
`wrangler.jsonc` under `vars`. Change it there and redeploy — no code change
needed:

```jsonc
{
  "vars": {
    "DOMAIN": "yourdomain.com"
  }
}
```

- Subdomain prefixes and their upstream registries are **hardcoded** in
  `UPSTREAM_PREFIXES` (`src/index.ts`).
- No other environment variables are used.
- Docker Hub official images get the `library/` prefix auto-rewritten
  (`nginx` → `library/nginx`); this applies only to `registry-1.docker.io`.

After changing any binding in `wrangler.jsonc`, regenerate types:

```bash
npx wrangler types
```

## Usage

Once deployed with `DOMAIN=yourdomain.com`, point your container client at the
desired registry subdomain. For example, to pull from Docker Hub:

```bash
# /etc/docker/daemon.json
{
  "registry-mirrors": ["https://docker.yourdomain.com"]
}
```

Then restart Docker and pull as usual:

```bash
docker pull nginx
```

Other registries are addressed directly by their subdomain:

```bash
docker pull ghcr.yourdomain.com/owner/image:tag
docker pull gcr.yourdomain.com/project/image:tag
docker pull quay.yourdomain.com/organization/image:tag
```

## Commands

| Command              | Purpose                            |
|----------------------|------------------------------------|
| `npm run dev`        | Local development (`wrangler dev`) |
| `npm run deploy`     | Deploy to Cloudflare               |
| `npm test`           | Run vitest                         |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` |

## Architecture

- **Single entry point:** `src/index.ts` — all logic lives here (no
  third-party deps; native Web API only).
- **Host routing:** `UPSTREAM_PREFIXES` maps a subdomain prefix to an upstream
  origin. The served host is built at request time as `<prefix>.${DOMAIN}`.
- **Token cache:** in-memory `Map` keyed by `service|scope`, honors
  `expires_in` (capped to 10s–1h, refreshed 5s ahead of expiry).
- **Redirect handling:** 301/302/303/307/308 followed manually (max 5) so the
  worker can strip the `Authorization` header on cross-host hops and apply its
  own anti-cache policy on the final response.

## Error Responses

| Status | Meaning                                                       |
|--------|---------------------------------------------------------------|
| `400`  | Invalid User-Agent — disallowed/missing client UA             |
| `404`  | Unknown registry / Not Found — unmapped host or non-`/v2/` path |
| `500`  | Token acquisition failed (logged via `console.error`)         |
| `502`  | Too many redirects (>5)                                       |
| `504`  | Gateway Timeout — upstream fetch threw                        |

Upstream 4xx/5xx responses are passed through verbatim.

## Tech Stack

- TypeScript (ES Modules), `strict: true`
- Runtime: Cloudflare Workers (`compatibility_date` in `wrangler.jsonc`,
  `nodejs_compat` flag enabled)
- Zero runtime dependencies; dev deps: `wrangler`, `typescript`, `vitest`,
  `@cloudflare/vitest-pool-workers`
- Tests use `@cloudflare/vitest-pool-workers` (Miniflare); `env` is injected
  from `wrangler.jsonc` `vars`, so tests see `DOMAIN` automatically.

## License

This project is provided as-is for personal use.
