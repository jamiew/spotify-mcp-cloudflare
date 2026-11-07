// The Worker end to end in workerd: a real OAuth grant from the real provider,
// real token exchanges, and real MCP clients on both protocol eras. Only
// Spotify is faked, by intercepting outbound fetches to spotify.com.
import { env, exports } from "cloudflare:workers";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { oauthOptions } from "./index";
import type { propsSchema } from "./utils";

const ORIGIN = "https://example.com";
const REDIRECT = "http://127.0.0.1:8976/callback";
const MINUTE = 60_000;

const worker = (input: string | URL, init?: RequestInit) =>
	exports.default.fetch(new Request(input, init));

const tokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
});
const oauthErrorResponse = z.object({ error: z.string() });

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Mints a grant the way /callback does, then redeems its code at /token. */
async function grant(overrides: Partial<z.input<typeof propsSchema>> = {}) {
	const registration = await worker(`${ORIGIN}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
	});
	const { client_id } = z.object({ client_id: z.string() }).parse(await registration.json());
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
	);
	const authorize = new URL(`${ORIGIN}/authorize`);
	authorize.search = new URLSearchParams({
		client_id,
		redirect_uri: REDIRECT,
		response_type: "code",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	}).toString();
	const oauth = getOAuthApi(oauthOptions(ORIGIN), env);
	const request = await oauth.parseAuthRequest(new Request(authorize));
	const props = {
		userId: "u1",
		displayName: "Test",
		email: "allowed@example.com",
		accessToken: "spotify-access-1",
		refreshToken: "spotify-refresh-1",
		expiresAt: Date.now() + 60 * MINUTE,
		scope: "user-read-private",
		...overrides,
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request,
		userId: props.userId,
		metadata: {},
		scope: request.scope,
		props,
	});
	const code = new URL(redirectTo).searchParams.get("code") ?? "";
	const res = await worker(`${ORIGIN}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT,
			client_id,
			code_verifier: verifier,
		}),
	});
	expect(res.status).toBe(200);
	return { clientId: client_id, ...tokenResponse.parse(await res.json()) };
}

const refresh = (clientId: string, refreshToken: string) =>
	worker(`${ORIGIN}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
		}),
	});

type SpotifyRoute = (request: Request) => Response | Promise<Response>;

type SeenRequest = { url: string; authorization: string | null; body: string };

/** Answers spotify.com fetches from the Worker; everything else goes out untouched. */
function fakeSpotify(routes: Record<string, SpotifyRoute>): SeenRequest[] {
	const seen: SeenRequest[] = [];
	const passthrough = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!url.hostname.endsWith("spotify.com")) return passthrough(input, init);
		// Read now: request bodies belong to the Worker's I/O context.
		seen.push({
			url: request.url,
			authorization: request.headers.get("Authorization"),
			body: new TextDecoder().decode(await request.clone().arrayBuffer()),
		});
		const route = routes[`${request.method} ${url.hostname}${url.pathname}`];
		return route ? route(request) : new Response(null, { status: 404 });
	});
	onTestFinished(() => {
		vi.restoreAllMocks();
	});
	return seen;
}

const profile = () =>
	Response.json({ id: "u1", display_name: "Test", email: "allowed@example.com" });

async function connect(accessToken: string, lane: "modern" | "legacy") {
	const client = new Client(
		{ name: "grant-test", version: "0" },
		lane === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			// Dropping the signal keeps close() from aborting a call into the Worker
			// mid-flight, which workerd reports as an unhandled AbortError.
			fetch: (url, init) => worker(url, { ...init, signal: null }),
			requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
		}),
	);
	onTestFinished(() => client.close());
	expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(lane === "modern");
	return client;
}

describe("a real grant", () => {
	it.each(["modern", "legacy"] as const)("serves the tool surface on the %s lane", async (lane) => {
		const seen = fakeSpotify({ "GET api.spotify.com/v1/me": profile });
		const { access_token, expires_in } = await grant();
		// The MCP token expires five minutes before the Spotify token it carries.
		expect(expires_in).toBeGreaterThan(54 * 60);
		expect(expires_in).toBeLessThanOrEqual(55 * 60);

		const client = await connect(access_token, lane);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("remove_tracks_from_playlist");
		const me = await client.callTool({ name: "get_me", arguments: {} });
		expect(me.structuredContent).toMatchObject({ id: "u1" });
		expect(seen.map((r) => r.authorization)).toEqual(["Bearer spotify-access-1"]);
	});

	it.each(["GET", "DELETE"])(
		"answers %s with 405 because there is no session to stream or end",
		async (method) => {
			fakeSpotify({});
			const { access_token } = await grant();
			const res = await worker(`${ORIGIN}/mcp`, {
				method,
				headers: { Authorization: `Bearer ${access_token}`, Accept: "text/event-stream" },
			});
			expect(res.status).toBe(405);
		},
	);

	it("accepts grants minted before scopes were stored", async () => {
		fakeSpotify({ "GET api.spotify.com/v1/me": profile });
		const { access_token } = await grant({ scope: undefined });
		const client = await connect(access_token, "modern");
		expect((await client.callTool({ name: "get_me", arguments: {} })).isError).toBeFalsy();
	});

	it("renews Spotify on refresh and keeps a rotated Spotify refresh token", async () => {
		let issued = 1;
		const seen = fakeSpotify({
			"POST accounts.spotify.com/api/token": () => {
				issued += 1;
				// Short-lived, so the next MCP refresh must renew Spotify again.
				return Response.json({
					access_token: `spotify-access-${issued}`,
					refresh_token: `spotify-refresh-${issued}`,
					expires_in: 120,
				});
			},
			"GET api.spotify.com/v1/me": profile,
		});
		const first = await grant({ expiresAt: Date.now() + 5 * MINUTE });
		// Below the five-minute margin the provider's floor applies.
		expect(first.expires_in).toBe(60);

		const second = tokenResponse.parse(
			await (await refresh(first.clientId, first.refresh_token)).json(),
		);
		const third = tokenResponse.parse(
			await (await refresh(first.clientId, second.refresh_token)).json(),
		);
		const tokenRequests = seen.filter((r) => r.url.endsWith("/api/token"));
		expect(tokenRequests.map((r) => new URLSearchParams(r.body).get("refresh_token"))).toEqual([
			"spotify-refresh-1",
			"spotify-refresh-2",
		]);
		expect(tokenRequests[0]?.authorization).toBe(
			`Basic ${btoa("test-client-id:test-client-secret")}`,
		);

		const client = await connect(third.access_token, "legacy");
		await client.callTool({ name: "get_me", arguments: {} });
		expect(seen.at(-1)?.authorization).toBe("Bearer spotify-access-3");
	});

	it("skips the Spotify refresh while its token has time left", async () => {
		const seen = fakeSpotify({});
		const { clientId, refresh_token } = await grant();
		const res = await refresh(clientId, refresh_token);
		expect(res.status).toBe(200);
		expect(tokenResponse.parse(await res.json()).expires_in).toBeGreaterThan(54 * 60);
		expect(seen).toEqual([]);
	});

	it("answers a stale Spotify token with a 401 that points the client at refresh", async () => {
		fakeSpotify({});
		const { access_token } = await grant({ expiresAt: Date.now() + 30_000 });
		const res = await worker(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${access_token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(401);
		const challenge = res.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toContain('error="invalid_token"');
		const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
		const metadata = z
			.object({ resource: z.string() })
			.parse(await (await worker(metadataUrl)).json());
		expect(metadata.resource).toBe(`${ORIGIN}/mcp`);
	});

	it("revokes the grant when Spotify rejects its refresh token", async () => {
		const seen = fakeSpotify({
			"POST accounts.spotify.com/api/token": () =>
				Response.json({ error: "invalid_grant" }, { status: 400 }),
		});
		const { clientId, refresh_token, access_token } = await grant({
			expiresAt: Date.now() + MINUTE,
		});
		const res = await refresh(clientId, refresh_token);
		expect(res.status).toBe(400);
		expect(oauthErrorResponse.parse(await res.json()).error).toBe("invalid_grant");
		// The grant and its tokens are gone, so nothing reaches Spotify again.
		expect((await refresh(clientId, refresh_token)).status).toBe(400);
		const call = await worker(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(call.status).toBe(401);
		expect(seen).toHaveLength(1);
	});

	it("keeps the grant when Spotify is briefly unavailable", async () => {
		let up = false;
		fakeSpotify({
			"POST accounts.spotify.com/api/token": () =>
				up
					? Response.json({ access_token: "spotify-access-2", expires_in: 3600 })
					: new Response("busy", { status: 503 }),
		});
		const { clientId, refresh_token } = await grant({ expiresAt: Date.now() + MINUTE });
		const failed = await refresh(clientId, refresh_token);
		expect(failed.status).toBe(503);
		expect(oauthErrorResponse.parse(await failed.json()).error).toBe("temporarily_unavailable");
		up = true;
		expect((await refresh(clientId, refresh_token)).status).toBe(200);
	});

	it("hides the tools from an account removed from the allowlist and revokes it on refresh", async () => {
		const seen = fakeSpotify({});
		const { clientId, refresh_token, access_token } = await grant({ email: "gone@example.com" });
		const client = await connect(access_token, "modern");
		expect((await client.listTools()).tools).toEqual([]);
		const res = await refresh(clientId, refresh_token);
		expect(oauthErrorResponse.parse(await res.json()).error).toBe("invalid_grant");
		expect(seen).toEqual([]);
	});

	it("no longer serves the deprecated SSE transport", async () => {
		expect((await worker(`${ORIGIN}/sse`)).status).toBe(404);
	});
});
