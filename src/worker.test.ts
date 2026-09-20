// Integration smoke tests against the real worker (OAuthProvider + handlers)
// running in workerd via the vitest workers pool.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());

describe("worker", () => {
	it("serves OAuth authorization server metadata", async () => {
		const res = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		const meta = jsonObject.parse(await res.json());
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
		const reg = jsonObject.parse(await res.json());
		expect(typeof reg.client_id).toBe("string");
	});

	it.each([undefined, "unregistered-client"])(
		"rejects an invalid client locally without using its redirect URI (%s)",
		async (clientId) => {
			const url = new URL("https://example.com/authorize");
			if (clientId) url.searchParams.set("client_id", clientId);
			url.searchParams.set("redirect_uri", "https://untrusted.example/callback");
			url.searchParams.set("response_type", "code");
			const res = await SELF.fetch(url.href, { redirect: "manual" });
			expect(res.status).toBe(400);
			expect(res.headers.has("location")).toBe(false);
			expect(jsonObject.parse(await res.json()).error).toBe("invalid_request");
		},
	);

	it("rejects a mismatched redirect but serves approval for the exact registered URI", async () => {
		const regRes = await SELF.fetch("https://example.com/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["http://localhost:8976/callback"],
				client_name: "test-client",
				token_endpoint_auth_method: "none",
			}),
		});
		expect(regRes.status).toBe(201);
		const reg = z.object({ client_id: z.string() }).parse(await regRes.json());
		const url = new URL("https://example.com/authorize");
		url.searchParams.set("client_id", reg.client_id);
		url.searchParams.set("redirect_uri", "http://127.0.0.1:8976/callback");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("code_challenge", "abc123");
		url.searchParams.set("code_challenge_method", "S256");
		const mismatch = await SELF.fetch(url.href, { redirect: "manual" });
		expect(mismatch.status).toBe(400);
		expect(mismatch.headers.has("location")).toBe(false);
		expect(jsonObject.parse(await mismatch.json()).error).toBe("invalid_request");

		url.searchParams.set("redirect_uri", "http://localhost:8976/callback");
		const res = await SELF.fetch(url.href, { redirect: "manual" });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("test-client");
		expect(html).toContain("csrf_token");
	});

	it("returns protocol errors only to a validated redirect with the original state and issuer", async () => {
		const regRes = await SELF.fetch("https://example.com/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://client.example/callback"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(regRes.status).toBe(201);
		const reg = z.object({ client_id: z.string() }).parse(await regRes.json());
		const url = new URL("https://example.com/authorize");
		url.searchParams.set("client_id", reg.client_id);
		url.searchParams.set("redirect_uri", "https://client.example/callback");
		url.searchParams.set("response_type", "token");
		url.searchParams.set("state", "original-client-state");
		const res = await SELF.fetch(url.href, { redirect: "manual" });
		expect(res.status).toBe(302);
		const redirect = new URL(res.headers.get("location") ?? "");
		expect(`${redirect.origin}${redirect.pathname}`).toBe("https://client.example/callback");
		expect(redirect.searchParams.get("error")).toBe("unsupported_response_type");
		expect(redirect.searchParams.get("state")).toBe("original-client-state");
		expect(redirect.searchParams.get("iss")).toBe("https://example.com");
		expect(redirect.searchParams.has("code")).toBe(false);
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

	it("serves favicon.ico as image bytes, not a redirect", async () => {
		const res = await SELF.fetch("https://example.com/favicon.ico", { redirect: "manual" });
		expect(res.status).toBe(200);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});
