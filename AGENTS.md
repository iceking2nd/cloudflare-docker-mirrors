# Cloudflare Workers — Docker Registry Mirror

A transparent Docker Registry V2 mirror proxy running on Cloudflare Workers.
Routes by request `Host` to an upstream registry, enforces a client
User-Agent allow-list, speaks the V2 protocol (Bearer token negotiation +
transparent CDN redirect following), and caches nothing.

> STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated.
> Always retrieve current documentation before any Workers, KV, R2, D1,
> Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Architecture

- **Single entry point:** `src/index.ts` — all logic lives here (no third-party
  deps; native Web API only).
- **Host routing:** `UPSTREAM_PREFIXES` maps a subdomain prefix to an upstream
  origin. The served host is built at request time as `<prefix>.${DOMAIN}`,
  where `DOMAIN` is the only environment variable (see Configuration).
- **Client gate:** only allow-listed container client User-Agents pass; others
  get `400 {"error":"Invalid User-Agent"}`.
- **No caching:** every response is forced `no-cache, no-store, must-revalidate`;
  no Cache API, no stored manifests/layer data.
- **Token cache:** in-memory `Map` keyed by `service|scope`, honors `expires_in`.

## Supported Registries

Only client-facing pull endpoints are exposed. Internal hosts reached via
redirect during a Docker Hub pull (`auth.docker.io`,
`production.cloudfront.docker.com`) are followed transparently by the worker
and are NOT listed.

| Subdomain            | Upstream                     |
|----------------------|------------------------------|
| `docker.{DOMAIN}`    | `registry-1.docker.io`       |
| `quay.{DOMAIN}`      | `quay.io`                    |
| `gcr.{DOMAIN}`       | `gcr.io`                     |
| `ghcr.{DOMAIN}`      | `ghcr.io`                    |
| `k8s.{DOMAIN}`       | `registry.k8s.io`            |
| `nvcr.{DOMAIN}`      | `nvcr.io`                    |
| `cloudsmith.{DOMAIN}`| `docker.cloudsmith.io`       |
| `ecr.{DOMAIN}`       | `public.ecr.aws`             |

Unknown host → `404 {"error":"Unknown registry"}`.

## Configuration

- The apex domain is the **`DOMAIN`** env var, set in `wrangler.jsonc` under
  `vars`. Change it there and redeploy — no code change needed.
- Subdomain prefixes and their upstream registries are **hardcoded** in
  `UPSTREAM_PREFIXES` (`src/index.ts`).
- No other environment variables are used.
- Docker Hub official images get the `library/` prefix auto-rewritten
  (`nginx` → `library/nginx`); this applies only to `registry-1.docker.io`.

After changing any binding in `wrangler.jsonc`, regenerate types:
```bash
npx wrangler types
```

## Docs

- Workers: https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`
- For all limits/quotas, retrieve from the product's `/platform/limits/` page,
  e.g. `/workers/platform/limits`
- Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Commands

| Command              | Purpose                          |
|----------------------|----------------------------------|
| `npm run dev`        | Local development (`wrangler dev`)|
| `npm run deploy`     | Deploy to Cloudflare             |
| `npm test`           | Run vitest                       |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` |

## Tech Stack & Constraints

- TypeScript (ES Modules), `strict: true`
- Runtime: Cloudflare Workers (`compatibility_date` in `wrangler.jsonc`,
  `nodejs_compat` flag enabled)
- Zero runtime dependencies; dev deps: `wrangler`, `typescript`, `vitest`,
  `@cloudflare/vitest-pool-workers`
- Tests use `@cloudflare/vitest-pool-workers` (Miniflare); `env` is injected
  from `wrangler.jsonc` `vars`, so tests see `DOMAIN` automatically.
- The `Request` constructor in tests does not set a `Host` header; the worker
  falls back to the URL hostname, so tests must use real-looking hosts.

## Errors

- `400` Invalid User-Agent — disallowed/missing client UA
- `404` Unknown registry / Not Found — unmapped host or non-`/v2/` path
- `500` Token acquisition failed (logged via `console.error`)
- `502` Too many redirects (>5)
- `504` Gateway Timeout — upstream fetch threw
- Upstream 4xx/5xx passed through verbatim
- **Error 1102** (CPU/Memory exceeded): retrieve limits from
  `/workers/platform/limits/`
- All errors: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/`
· `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant
best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
