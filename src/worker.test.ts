// Integration smoke tests against the real worker (OAuthProvider + handlers)
// running in workerd via the vitest workers pool.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
	it("serves OAuth authorization server metadata", async () => {
		const res = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		const meta = (await res.json()) as Record<string, unknown>;
		expect(meta.authorization_endpoint).toBe("https://example.com/authorize");
		expect(meta.token_endpoint).toBe("https://example.com/token");
		expect(meta.registration_endpoint).toBe("https://example.com/register");
		expect(meta.code_challenge_methods_supported).toContain("S256");
	});

	it("rejects unauthenticated MCP requests", async () => {
		const res = await SELF.fetch("https://example.com/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		expect(res.status).toBe(401);
	});

	it("registers a client via dynamic client registration", async () => {
		const res = await SELF.fetch("https://example.com/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://client.example/callback"],
				client_name: "test-client",
				token_endpoint_auth_method: "none",
			}),
		});
		expect(res.status).toBe(201);
		const reg = (await res.json()) as Record<string, unknown>;
		expect(typeof reg.client_id).toBe("string");
	});

	it("serves the approval dialog for a registered client's authorize request", async () => {
		const regRes = await SELF.fetch("https://example.com/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://client.example/callback"],
				client_name: "test-client",
				token_endpoint_auth_method: "none",
			}),
		});
		const reg = (await regRes.json()) as { client_id: string };
		const url = new URL("https://example.com/authorize");
		url.searchParams.set("client_id", reg.client_id);
		url.searchParams.set("redirect_uri", "https://client.example/callback");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("code_challenge", "abc123");
		url.searchParams.set("code_challenge_method", "S256");
		const res = await SELF.fetch(url.href);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("test-client");
		expect(html).toContain("csrf_token");
	});

	it("serves the icon as both svg and png", async () => {
		const svg = await SELF.fetch("https://example.com/icon.svg");
		expect(svg.headers.get("content-type")).toContain("image/svg+xml");
		expect(await svg.text()).toContain("<svg");

		const png = await SELF.fetch("https://example.com/icon.png");
		expect(png.headers.get("content-type")).toContain("image/png");
		const bytes = new Uint8Array(await png.arrayBuffer());
		expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});
