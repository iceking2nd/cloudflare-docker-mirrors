import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function makeReq(url: string, userAgent?: string): Request {
	const req = new IncomingRequest(url);
	if (userAgent === undefined) {
		req.headers.delete("user-agent");
	} else {
		req.headers.set("user-agent", userAgent);
	}
	return req;
}

async function call(url: string, userAgent?: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(makeReq(url, userAgent), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe("docker registry mirror proxy", () => {
	it("returns 404 Unknown registry for unmapped hosts", async () => {
		const res = await call("https://example.com/v2/", "docker/27.0");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Unknown registry" });
	});

	it("returns 404 for non-V2 paths on a known host", async () => {
		const res = await call("https://docker.yourdomain.com/", "docker/27.0");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	it("returns 400 Invalid User-Agent for disallowed clients", async () => {
		const res = await call("https://docker.yourdomain.com/v2/", "curl/8.0");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid User-Agent" });
	});

	it("returns 400 Invalid User-Agent when User-Agent is missing", async () => {
		const res = await call("https://docker.yourdomain.com/v2/");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid User-Agent" });
	});

	it("accepts allowed clients case-insensitively (UA gate passed)", async () => {
		// A known host with an allowed UA and a non-V2 path returns 404 Not Found
		// — proving the request passed the User-Agent gate (which would otherwise
		// have returned 400 Invalid User-Agent) without touching the network.
		const res = await call("https://docker.yourdomain.com/", "ContainerD/v1.7");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	it("applies anti-cache headers on error responses", async () => {
		const res = await call("https://example.com/v2/", "docker/27.0");
		expect(res.headers.get("cache-control")).toBe(
			"no-cache, no-store, must-revalidate",
		);
		expect(res.headers.get("pragma")).toBe("no-cache");
		expect(res.headers.get("expires")).toBe("0");
	});
});
