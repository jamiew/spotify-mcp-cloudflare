import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPOTIFY_SCOPES, SPOTIFY_TOKEN_URL } from "../utils";
import { LocalTokenProvider, login } from "./auth";
import { LocalTokenStore } from "./token-store";

const directories: string[] = [];
const stores: LocalTokenStore[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function temporaryStore(): Promise<{ store: LocalTokenStore; directory: string }> {
	const directory = await mkdtemp(join(tmpdir(), "spotify-local-test-"));
	directories.push(directory);
	const store = await LocalTokenStore.acquire(directory);
	stores.push(store);
	return { store, directory };
}

describe("local PKCE login", () => {
	it("exchanges only the matching callback code, bound to the S256 verifier and public client", async () => {
		let authorization: URL | undefined;
		const callbacks: Promise<Response>[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			expect(input).toBe(SPOTIFY_TOKEN_URL);
			const body = new URLSearchParams(String(init?.body));
			const verifier = body.get("code_verifier") ?? "";
			expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
			expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
				authorization?.searchParams.get("code_challenge"),
			);
			expect(body.get("client_id")).toBe("public-client");
			expect(body.get("code")).toBe("accepted-code");
			expect(body.get("redirect_uri")).toBe(authorization?.searchParams.get("redirect_uri"));
			expect(body.has("client_secret")).toBe(false);
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			return Response.json({
				access_token: "access",
				refresh_token: "refresh",
				token_type: "Bearer",
				expires_in: 3600,
			});
		};
		const tokens = await login({
			clientId: "public-client",
			callbackPort: 0,
			fetchImpl,
			onAuthorize: (value) => {
				authorization = new URL(value);
				expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
				expect(authorization.searchParams.get("scope")).toBe(SPOTIFY_SCOPES);
				const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
				expect(callback.hostname).toBe("127.0.0.1");
				callback.search = new URLSearchParams({
					code: "accepted-code",
					state: authorization.searchParams.get("state") ?? "",
				}).toString();
				callbacks.push(fetch(callback));
			},
		});
		expect(tokens.refreshToken).toBe("refresh");
		expect((await Promise.all(callbacks))[0]?.status).toBe(200);
	});

	it("rejects mismatched state without a token exchange and releases the callback port", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const callbacks: Promise<Response>[] = [];
		let callbackUrl: URL | undefined;
		await expect(
			login({
				clientId: "public-client",
				callbackPort: 0,
				fetchImpl,
				onAuthorize: (value) => {
					callbackUrl = new URL(new URL(value).searchParams.get("redirect_uri") ?? "");
					callbackUrl.search = new URLSearchParams({
						code: "stolen-code",
						state: "wrong-state",
					}).toString();
					callbacks.push(fetch(callbackUrl));
				},
			}),
		).rejects.toThrow("state verification failed");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await Promise.all(callbacks))[0]?.status).toBe(400);
		if (!callbackUrl) throw new Error("Login did not start a callback listener.");
		await expect(fetch(callbackUrl)).rejects.toThrow();
	});

	it("expires an unanswered callback instead of hanging indefinitely", async () => {
		await expect(
			login({
				clientId: "public-client",
				callbackPort: 0,
				timeoutMs: 50,
				onAuthorize: () => {},
			}),
		).rejects.toThrow("timed out or was cancelled");
	});

	it("fails before authorization when the callback port is occupied", async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
		const address = occupied.address();
		if (!address || typeof address === "string") throw new Error("No test listener.");
		const onAuthorize = vi.fn();
		try {
			await expect(
				login({ clientId: "public-client", callbackPort: address.port, onAuthorize }),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
			expect(onAuthorize).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});
});

describe("local token ownership and rotation", () => {
	it("deduplicates expired-token refreshes and uses the persisted rotation after reopening", async () => {
		const { store, directory } = await temporaryStore();
		await store.write({
			version: 1,
			clientId: "public-client",
			accessToken: "expired",
			refreshToken: "original-refresh",
			expiresAt: 1,
			scope: SPOTIFY_SCOPES,
		});
		let refreshCalls = 0;
		const fetchImpl: typeof fetch = async (_input, init) => {
			refreshCalls++;
			expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
				refreshCalls === 1 ? "original-refresh" : "rotated-refresh",
			);
			return Response.json({
				access_token: `access-${refreshCalls}`,
				...(refreshCalls === 1 ? { refresh_token: "rotated-refresh" } : {}),
				token_type: "Bearer",
				expires_in: 3600,
			});
		};
		const provider = await LocalTokenProvider.load(store, "public-client", fetchImpl);
		expect(
			await Promise.all([
				provider.getAccessToken(),
				provider.getAccessToken(),
				provider.refreshAccessToken(),
			]),
		).toEqual(["access-1", "access-1", "access-1"]);
		expect(refreshCalls).toBe(1);
		expect((await store.read())?.refreshToken).toBe("rotated-refresh");
		expect((await stat(join(directory, "tokens.json"))).mode & 0o777).toBe(0o600);
		await provider.close();
		await store.close();
		const reopened = await LocalTokenStore.acquire(directory);
		stores.push(reopened);
		const next = await LocalTokenProvider.load(reopened, "public-client", fetchImpl);
		expect(await next.refreshAccessToken()).toBe("access-2");
		expect((await reopened.read())?.refreshToken).toBe("rotated-refresh");
		await next.close();
	});

	it("rejects a second owner until the first releases the grant", async () => {
		const { store, directory } = await temporaryStore();
		await expect(LocalTokenStore.acquire(directory)).rejects.toThrow("already in use");
		await store.close();
		const replacement = await LocalTokenStore.acquire(directory);
		stores.push(replacement);
		await replacement.write({
			version: 1,
			clientId: "client",
			accessToken: "access",
			refreshToken: "refresh",
			expiresAt: Date.now() + 1000,
			scope: SPOTIFY_SCOPES,
		});
		await replacement.clear();
		expect(await replacement.read()).toBeNull();
	});

	it("does not reuse a consumed refresh grant when persisting its rotation fails", async () => {
		const { store } = await temporaryStore();
		await store.write({
			version: 1,
			clientId: "client",
			accessToken: "expired",
			refreshToken: "old",
			expiresAt: 1,
			scope: SPOTIFY_SCOPES,
		});
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				access_token: "new",
				refresh_token: "rotated",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		);
		const provider = await LocalTokenProvider.load(store, "client", fetchImpl);
		vi.spyOn(store, "write").mockRejectedValue(new Error("disk full"));
		await expect(provider.getAccessToken()).rejects.toThrow("safely save");
		await expect(provider.getAccessToken()).rejects.toThrow("safely save");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await provider.close();
	});
});
