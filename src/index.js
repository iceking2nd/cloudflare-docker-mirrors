export default {
	async fetch(request, env, ctx) {
		const DOMAINS = {
			["docker." + env.DOMAIN]: "registry-1.docker.io",
			["auth-docker." + env.DOMAIN]: "auth.docker.io",
			["quay." + env.DOMAIN]: "quay.io",
			["gcr." + env.DOMAIN]: "gcr.io",
			["ghcr." + env.DOMAIN]: "ghcr.io",
			["k8s." + env.DOMAIN]: "registry.k8s.io",
			["nvcr." + env.DOMAIN]: "nvcr.io",
			["cloudsmith." + env.DOMAIN]: "docker.cloudsmith.io",
			["ecr." + env.DOMAIN] : "public.ecr.aws"
		};

		const ALLOWED_CLIENTS = [
			"containers",
			"podman",
			"docker",
			"curl",
			"nexus"
		]

		const client_allowed = ALLOWED_CLIENTS.find(client => request.headers.get("user-agent")?.toLowerCase().includes(client));
		if (!client_allowed) {
			console.debug(`client not allowed: ${request.headers.get("user-agent")}`);
			return new Response("Bad request", { status: 400 });
		}

		const requestUrl = new URL(request.url);
		console.debug(`request url: ${requestUrl}`);

		if (!DOMAINS[requestUrl.hostname]) {
			return new Response("Bad request", { status: 400 });
		}

		const ALLOWED_PATHS = [
			"/v1/",
			"/v2/",
			"/token",
			"/proxy_auth",
			"/login"
		]

		const path_allowed = ALLOWED_PATHS.find(path => requestUrl.pathname.startsWith(path));

		if (!path_allowed) {
			console.debug(`path not allowed: ${requestUrl.pathname}`);
			return new Response("Bad request", { status: 400 });
		}

		const AUTH_HEADERS = [
			{ key: "auth.docker.io" , value: `auth-docker.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "quay.io", value: `quay.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "gcr.io", value: `gcr.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "ghcr.io", value: `ghcr.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "nvcr.io", value: `nvcr.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "docker.cloudsmith.io", value: `cloudsmith.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`},
			{ key: "public.ecr.aws", value: `ecr.${env.DOMAIN}${requestUrl.port !== "" ? `:${requestUrl.port}` : ""}`}
		]

		switch (DOMAINS[requestUrl.hostname]) {
			case "registry-1.docker.io":
				const pathMatch = requestUrl.pathname.match(/^\/v2\/([^/]+)\/(manifests|blobs)\/.+$/);
				console.debug(`pathMatch: ${pathMatch}`)
				if (pathMatch) {
					const imageName = pathMatch[1];
					if (!imageName.includes('/')) { // 没有 namespace
						console.debug(`namespace missing in path, rewriting to /v2/library/${imageName}...`);
						requestUrl.pathname = requestUrl.pathname.replace(/^\/v2\/([^/]+)\//, `/v2/library/$1/`);
					}
				}
				break;
			case "auth.docker.io":
				if (requestUrl.pathname.startsWith("/token")) {
					const scope = requestUrl.searchParams.get("scope"); // 已自动解码
					console.debug(`scope: ${scope}`);
					if (scope) {
						const scopeMatch = scope.match(/^repository:([^:/]+):/);
						if (scopeMatch) {
							const repoName = scopeMatch[1];
							console.debug(`repoName: ${repoName}`);
							if (!repoName.includes('/')) { // 没有 namespace
								console.debug(`namespace missing in scope, rewriting to library/${repoName}`);
								const newScope = scope.replace(/^repository:([^:/]+):/, `repository:library/$1:`);
								requestUrl.searchParams.set("scope", newScope); // 自动重新 URL 编码
							}
						}
					}
				}
				break;
			default:
				break;
		}

		const newReqUrl = new URL(`https://${DOMAINS[requestUrl.hostname]}${requestUrl.pathname}${requestUrl.search}`);
		console.debug(`new request url: ${newReqUrl}`);

		console.debug(`request headers:`, [...request.headers.entries()]);

		const newRequestHeaders = new Headers();
		for (const [key, value] of request.headers) {
			switch (key.toLowerCase()) {
				case "host":
					newRequestHeaders.set(key, DOMAINS[requestUrl.hostname]);
					break;
				default:
					newRequestHeaders.set(key, value);
					break;
			}
		}

		console.debug(`modified request headers to:`, [...newRequestHeaders.entries()]);

		const response = await fetch(newReqUrl, {
			method: request.method,
			headers: newRequestHeaders,
			body: request.body,
			redirect: "follow"
		});

		console.debug(`response header:`, [...response.headers.entries()]);

		const newResponseHeaders = new Headers();
		for (const [key, value] of response.headers) {
			switch (key.toLowerCase()) {
				case "www-authenticate":
					const header_found = AUTH_HEADERS.find(obj => value.includes(obj.key))
					if (header_found) {
						let newAuthHeader = value.replace(/(realm="https:\/\/)([^/]+)(\/.*")/, (match, prefix, domain, suffix) => {
							if (domain === header_found.key) {
								return `${prefix}${header_found.value}${suffix}`;
							}
							return match; // 如果不是目标域名，不替换
						});
						newAuthHeader = newAuthHeader.replace(/scope=repository:([^:/]+):pull/, (match, repoName) => {
							if (!repoName.includes('/')) {
								console.debug(`scope missing namespace, rewriting to library/${repoName}`);
								return `scope=repository:library/${repoName}:pull`;
							}
							return match;
						});
						newResponseHeaders.set(key, newAuthHeader);
					}
					break;
				default:
					newResponseHeaders.set(key, value);
					break;
			}
		}

		console.debug(`modified response headers to:`, [...newResponseHeaders.entries()]);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newResponseHeaders,
		});
	},
};
