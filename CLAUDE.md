# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker that reverse-proxies multiple container registries (Docker Hub, Quay, GCR, GHCR, K8s, NVCR, Cloudsmith, ECR) through custom subdomains. Each registry maps to a `{registry}.{DOMAIN}` subdomain pattern, and the worker rewrites headers/URLs to make the mirror transparent to container clients.

## Commands

```bash
npm run dev          # Local dev server (port 8787, uses development env vars)
npm start            # Local dev server (no env override)
npm run deploy       # Deploy using default wrangler.jsonc
npm test             # Run vitest
```

Domain-specific deployments require specifying the config explicitly:
```bash
npx wrangler deploy --config wrangler-wxc.jsonc
npx wrangler deploy --config wrangler-boda.jsonc
```

## Architecture

All logic lives in `src/index.js` — a single Worker `fetch` handler with this pipeline:

1. **User-Agent filtering** — Only allowed container clients (`docker`, `containerd`, `podman`, `buildah`, `containers`, `curl`, `nexus`) are accepted; others get 400.
2. **Domain mapping** — Request hostname maps to upstream registry (e.g., `docker.{DOMAIN}` → `registry-1.docker.io`).
3. **Path filtering** — Only `/v1/`, `/v2/`, `/token`, `/proxy_auth`, `/login` paths allowed.
4. **Docker Hub namespace rewrite** — Single-segment image names get `library/` prefix injected in both the path and the `scope` query param, since Docker Hub requires namespace-qualified paths.
5. **Proxy with manual redirect** — Request forwarded with rewritten `Host` header; redirects (`redirect: 'manual'`) to cloud storage domains (`cloudflarestorage.com`, `s3.amazonaws.com`, `cloudflare.docker.com`) are followed server-side to avoid exposing storage URLs.
6. **Response header rewriting** — `www-authenticate` headers have upstream auth domain URLs replaced with mirror subdomain URLs, so client auth flows route back through the mirror.

## Key Configuration

- `DOMAIN` env var determines the subdomain pattern. Set in wrangler config per environment.
- Three wrangler configs exist: `wrangler.jsonc` (default/dev), `wrangler-boda.jsonc` (drcloud.com.cn), `wrangler-wxc.jsonc` (wxc.kg). The per-domain configs are gitignored.
- `compatibility_flags: ["nodejs_compat"]` is required.

## Code Style

- Tabs, 140 char print width, single quotes, semicolons (see `.prettierrc` and `.editorconfig`)
- Plain JavaScript, no TypeScript
