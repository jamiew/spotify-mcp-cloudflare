import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exchangeCodeForToken,
	getUpstreamAuthorizeUrl,
	isAccountAllowed,
	refreshSpotifyToken,
} from "./utils";

// Minimal fake Spotify accounts server: every test that talks to the token
// endpoint installs one canned response and asserts on the request it got.
function fakeTokenEndpoint(status: number, body: unknown) {
	const seen: { body: URLSearchParams; auth: string | null }[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const req = new Request(input, init);
			expect(req.url).toBe("https://accounts.spotify.com/api/token");
			seen.push({
				body: new URLSearchParams(await req.text()),
				auth: req.headers.get("Authorization"),
			});
			return Response.json(body, { status });
		},
	);
	return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("isAccountAllowed", () => {
	it("allows everyone when no list is configured", () => {
		expect(isAccountAllowed(["a@b.com"], "")).toBe(true);
		expect(isAccountAllowed(["a@b.com"], null)).toBe(true);
	});

	it("matches case-insensitively and trims entries", () => {
		expect(isAccountAllowed(["A@B.com"], " a@b.com , c@d.com")).toBe(true);
		expect(isAccountAllowed(["x@y.com"], "a@b.com")).toBe(false);
		expect(isAccountAllowed([undefined], "a@b.com")).toBe(false);
	});

	it("matches on user id when email is unavailable (restricted apps)", () => {
		expect(isAccountAllowed([undefined, "jamiew"], "a@b.com, jamiew")).toBe(true);
		expect(isAccountAllowed([null, "someone-else"], "jamiew")).toBe(false);
	});
});

describe("getUpstreamAuthorizeUrl", () => {
	it("builds the Spotify authorize URL with all params", () => {
		const url = new URL(
			getUpstreamAuthorizeUrl({
				clientId: "cid",
				scope: "user-read-private",
				redirectUri: "https://example.com/callback",
				state: "abc123",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
		expect(url.searchParams.get("state")).toBe("abc123");
	});
});

describe("exchangeCodeForToken", () => {
	it("exchanges a code with Basic auth and computes expiresAt", async () => {
		const seen = fakeTokenEndpoint(200, {
			access_token: "at",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "rt",
		});
		const before = Date.now();
		const tokens = await exchangeCodeForToken({
			clientId: "cid",
			clientSecret: "secret",
			code: "code",
			redirectUri: "https://example.com/callback",
		});
		expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt" });
		expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
		expect(seen[0]?.auth).toBe(`Basic ${btoa("cid:secret")}`);
		expect(seen[0]?.body.get("grant_type")).toBe("authorization_code");
		expect(seen[0]?.body.get("code")).toBe("code");
	});

	it("rejects when Spotify omits the refresh token", async () => {
		fakeTokenEndpoint(200, { access_token: "at", token_type: "Bearer", expires_in: 3600 });
		await expect(
			exchangeCodeForToken({
				clientId: "cid",
				clientSecret: "secret",
				code: "code",
				redirectUri: "https://example.com/callback",
			}),
		).rejects.toThrow(/refresh token/);
	});

	it("rejects on a non-2xx token response", async () => {
		fakeTokenEndpoint(400, { error: "invalid_grant" });
		await expect(
			exchangeCodeForToken({
				clientId: "cid",
				clientSecret: "secret",
				code: "bad",
				redirectUri: "https://example.com/callback",
			}),
		).rejects.toThrow(/400/);
	});
});

describe("refreshSpotifyToken", () => {
	it("returns fresh tokens, passing through a rotated refresh token", async () => {
		const seen = fakeTokenEndpoint(200, {
			access_token: "at2",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "rt2",
		});
		const tokens = await refreshSpotifyToken({
			clientId: "cid",
			clientSecret: "secret",
			refreshToken: "rt",
		});
		expect(tokens).toMatchObject({ accessToken: "at2", refreshToken: "rt2" });
		expect(seen[0]?.body.get("grant_type")).toBe("refresh_token");
		expect(seen[0]?.body.get("refresh_token")).toBe("rt");
	});

	it("leaves refreshToken undefined when Spotify does not rotate", async () => {
		fakeTokenEndpoint(200, { access_token: "at2", token_type: "Bearer", expires_in: 3600 });
		const tokens = await refreshSpotifyToken({
			clientId: "cid",
			clientSecret: "secret",
			refreshToken: "rt",
		});
		expect(tokens.refreshToken).toBeUndefined();
	});
});
