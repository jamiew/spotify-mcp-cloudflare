import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	clamp,
	RateLimitedError,
	ResponseShapeError,
	SpotifyApiError,
	SpotifyAuthError,
	SpotifyClient,
	type TokenProvider,
	toId,
	toUri,
} from "./spotify";

// Fake Spotify upstream: routes keyed by "METHOD /path", every request recorded.
export interface SeenRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
	token: string | null;
}

export function fakeSpotify(routes: Record<string, (seen: SeenRequest) => Response>) {
	const seen: SeenRequest[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		const bodyText = await req.text();
		const record: SeenRequest = {
			method: req.method,
			path: url.pathname,
			query: url.searchParams,
			body: bodyText ? JSON.parse(bodyText) : undefined,
			token: req.headers.get("Authorization")?.replace("Bearer ", "") ?? null,
		};
		seen.push(record);
		const route = routes[`${req.method} ${url.pathname}`];
		return (
			route?.(record) ??
			Response.json({ error: { status: 404, message: "Service not found" } }, { status: 404 })
		);
	}) as typeof fetch;
	return { seen, fetchImpl };
}

export function staticTokens(): TokenProvider {
	return {
		getAccessToken: async () => "tok",
		refreshAccessToken: async () => "tok2",
	};
}

function makeClient(
	routes: Record<string, (seen: SeenRequest) => Response>,
	overrides: Partial<ConstructorParameters<typeof SpotifyClient>[0]> = {},
) {
	const fake = fakeSpotify(routes);
	const client = new SpotifyClient({
		tokenProvider: staticTokens(),
		fetchImpl: fake.fetchImpl,
		sleep: async () => {},
		...overrides,
	});
	return { client, seen: fake.seen };
}

const nameSchema = z.object({ name: z.string() });

describe("SpotifyClient", () => {
	it("requests with a bearer token and parses the response", async () => {
		const { client, seen } = makeClient({
			"GET /v1/thing": () => Response.json({ name: "x", extra: 1 }),
		});
		const res = await client.request("/thing", nameSchema);
		expect(res).toEqual({ name: "x" });
		expect(seen[0]?.token).toBe("tok");
	});

	it("refreshes and retries once on 401", async () => {
		let calls = 0;
		const { client, seen } = makeClient({
			"GET /v1/thing": () => {
				calls += 1;
				return calls === 1
					? Response.json({ error: { status: 401 } }, { status: 401 })
					: Response.json({ name: "after-refresh" });
			},
		});
		const res = await client.request("/thing", nameSchema);
		expect(res.name).toBe("after-refresh");
		expect(seen[1]?.token).toBe("tok2");
	});

	it("throws SpotifyAuthError when the refreshed token also 401s", async () => {
		const { client } = makeClient({
			"GET /v1/thing": () => Response.json({ error: { status: 401 } }, { status: 401 }),
		});
		await expect(client.request("/thing", nameSchema)).rejects.toThrow(SpotifyAuthError);
	});

	it("backs off on 429 honoring a bounded Retry-After, then succeeds", async () => {
		const waits: number[] = [];
		let calls = 0;
		const { client } = makeClient(
			{
				"GET /v1/thing": () => {
					calls += 1;
					return calls === 1
						? Response.json({}, { status: 429, headers: { "Retry-After": "120" } })
						: Response.json({ name: "ok" });
				},
			},
			{
				sleep: async (ms) => {
					waits.push(ms);
				},
				maxRetryAfterSeconds: 5,
			},
		);
		const res = await client.request("/thing", nameSchema);
		expect(res.name).toBe("ok");
		expect(waits).toEqual([5000]);
	});

	it("gives up with RateLimitedError after max 429 retries", async () => {
		const { client, seen } = makeClient(
			{ "GET /v1/thing": () => Response.json({}, { status: 429 }) },
			{ maxRateLimitRetries: 2 },
		);
		await expect(client.request("/thing", nameSchema)).rejects.toThrow(RateLimitedError);
		expect(seen.length).toBe(3);
	});

	it("throws SpotifyApiError with the extracted reason on other failures", async () => {
		const { client } = makeClient({
			"PUT /v1/me/player/play": () =>
				Response.json({ error: { status: 403, reason: "PREMIUM_REQUIRED" } }, { status: 403 }),
		});
		const err = await client
			.requestVoid("/me/player/play", { method: "PUT" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SpotifyApiError);
		expect(err).toMatchObject({ status: 403, reason: "PREMIUM_REQUIRED" });
	});

	it("throws ResponseShapeError when the response fails the schema", async () => {
		const { client } = makeClient({
			"GET /v1/thing": () => Response.json({ name: 42 }),
		});
		await expect(client.request("/thing", nameSchema)).rejects.toThrow(ResponseShapeError);
	});

	it("parses 204-no-content as undefined for optional schemas", async () => {
		const { client } = makeClient({
			"GET /v1/me/player": () => new Response(null, { status: 204 }),
		});
		const res = await client.request("/me/player", nameSchema.optional());
		expect(res).toBeUndefined();
	});

	describe("withFallback", () => {
		it("falls back to legacy on 404 and caches the family", async () => {
			const { client, seen } = makeClient({
				"GET /v1/new-style": () =>
					Response.json({ error: { status: 404, message: "Service not found" } }, { status: 404 }),
				"GET /v1/legacy": () => Response.json({ name: "legacy" }),
			});
			const call = () =>
				client.withFallback(
					"fam",
					() => client.request("/new-style", nameSchema),
					() => client.request("/legacy", nameSchema),
				);
			expect((await call()).name).toBe("legacy");
			expect((await call()).name).toBe("legacy");
			// first call tried both paths; second went straight to legacy
			expect(seen.map((s) => s.path)).toEqual(["/v1/new-style", "/v1/legacy", "/v1/legacy"]);
		});

		it("does not fall back on a NO_ACTIVE_DEVICE 404", async () => {
			const { client, seen } = makeClient({
				"POST /v1/me/player/next": () =>
					Response.json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, { status: 404 }),
			});
			const err = await client
				.withFallback(
					"playback",
					() => client.requestVoid("/me/player/next", { method: "POST" }),
					() => client.requestVoid("/never-called", { method: "POST" }),
				)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SpotifyApiError);
			expect(seen.map((s) => s.path)).toEqual(["/v1/me/player/next"]);
		});

		it("does not cache legacy when the legacy call also fails", async () => {
			const { client, seen } = makeClient({});
			const call = () =>
				client.withFallback(
					"fam",
					() => client.request("/a", nameSchema),
					() => client.request("/b", nameSchema),
				);
			await expect(call()).rejects.toThrow(SpotifyApiError);
			await expect(call()).rejects.toThrow(SpotifyApiError);
			// second call still tries the restricted path first: nothing was cached
			expect(seen.map((s) => s.path)).toEqual(["/v1/a", "/v1/b", "/v1/a", "/v1/b"]);
		});
	});

	it("paginates until the requested total or a short page", async () => {
		const pages: Record<string, string[]> = {
			"0": ["a", "b"],
			"2": ["c", "d"],
			"4": ["e"],
		};
		const { client } = makeClient({
			"GET /v1/list": (req) =>
				Response.json({ items: pages[req.query.get("offset") ?? "0"] ?? [] }),
		});
		const listSchema = z.object({ items: z.array(z.string()) });
		const items = await client.paginate<string>(
			async (limit, offset) => {
				const page = await client.request("/list", listSchema, { query: { limit, offset } });
				return { items: page.items, hasNext: true };
			},
			{ total: 10, perRequest: 2 },
		);
		expect(items).toEqual(["a", "b", "c", "d", "e"]);
	});
});

describe("toUri / toId / clamp", () => {
	it("normalizes ids and uris both directions", () => {
		expect(toUri("track", "abc")).toBe("spotify:track:abc");
		expect(toUri("track", "spotify:track:abc")).toBe("spotify:track:abc");
		expect(toId("spotify:playlist:xyz")).toBe("xyz");
		expect(toId("xyz")).toBe("xyz");
	});

	it("clamps into range", () => {
		expect(clamp(0, 1, 50)).toBe(1);
		expect(clamp(99, 1, 50)).toBe(50);
		expect(clamp(10, 1, 50)).toBe(10);
	});
});
