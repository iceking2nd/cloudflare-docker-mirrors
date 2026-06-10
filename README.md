# cloudflare-docker-mirrors

Cloudflare Worker that reverse-proxies multiple container registries through custom subdomains, making it easy to mirror Docker Hub and other registries behind your own domain.

## Supported Registries

| Subdomain | Upstream |
|---|---|
| `docker.{DOMAIN}` | `registry-1.docker.io` |
| `auth-docker.{DOMAIN}` | `auth.docker.io` |
| `quay.{DOMAIN}` | `quay.io` |
| `gcr.{DOMAIN}` | `gcr.io` |
| `ghcr.{DOMAIN}` | `ghcr.io` |
| `k8s.{DOMAIN}` | `registry.k8s.io` |
| `nvcr.{DOMAIN}` | `nvcr.io` |
| `cloudsmith.{DOMAIN}` | `docker.cloudsmith.io` |
| `ecr.{DOMAIN}` | `public.ecr.aws` |
| `cloudfront-docker.{DOMAIN}` | `production.cloudfront.docker.com` |

## How It Works

1. **User-Agent filtering** — Only known container clients are allowed (`docker`, `containerd`, `podman`, `buildah`, `containers`, `curl`, `nexus`).
2. **Domain mapping** — Request hostname is mapped to the upstream registry.
3. **Path filtering** — Only `/v1/`, `/v2/`, `/token`, `/proxy_auth`, `/login` paths are proxied.
4. **Docker Hub namespace rewrite** — Single-segment image names (e.g., `nginx`) automatically get the `library/` prefix in both paths and auth scopes.
5. **Server-side redirect following** — Redirects to cloud storage domains (`cloudflarestorage.com`, `s3.amazonaws.com`, `cloudflare.docker.com`, `production.cloudfront.docker.com`) are followed server-side, avoiding exposure of storage URLs.
6. **Response header rewriting** — `www-authenticate` headers are rewritten so auth flows route back through the mirror.

## Setup

1. Set the `DOMAIN` environment variable in your wrangler config to your domain.
2. Configure DNS records and Cloudflare routes for each `{registry}.{DOMAIN}` subdomain pointing to this Worker.
3. Deploy:

```bash
npm run deploy
```

For domain-specific deployments:

```bash
npx wrangler deploy --config wrangler-<name>.jsonc
```

## Development

```bash
npm install
npm run dev      # Local dev server with development env vars (port 8787)
npm start        # Local dev server without env override
npm test         # Run tests
```

## License

[MIT](LICENSE)
