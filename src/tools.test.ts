// Drives the real tool surface through a real MCP client with a fake Spotify
// behind it, so argument validation, error mapping and output shaping are
// exercised the way a client sees them. Every test runs on each lane a client
// can reach this server through:
//
// - modern: the 2026-07-28 revision over the Worker's stateless HTTP handler.
// - legacy-http: a 2025-era client on that same handler, which answers each
//   POST with a fresh server and has no way to ask the client anything.
// - legacy-session: a 2025-era connection that keeps its session, as stdio does.
import {
	Client,
	type ClientCapabilities,
	type ElicitRequest,
	type ElicitResult,
	InMemoryTransport,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { fakeSpotify, type SeenRequest, staticTokens } from "./fake-spotify";
import { createSpotifyServer } from "./server";
import { SpotifyClient } from "./spotify";

const LANES = ["modern", "legacy-http", "legacy-session"] as const;
type Lane = (typeof LANES)[number];
type Routes = Record<string, (seen: SeenRequest) => Response | Promise<Response>>;
type ConnectOptions = {
	capabilities?: ClientCapabilities;
	elicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
	timeoutMs?: number;
};

async function connectOver(lane: Lane, routes: Routes, options: ConnectOptions = {}) {
	const fake = fakeSpotify(routes);
	const spotify = new SpotifyClient({
		tokenProvider: staticTokens(),
		fetchImpl: fake.fetchImpl,
		sleep: async () => {},
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
	const client = new Client(
		{ name: "test-client", version: "0" },
		{
			capabilities: options.capabilities ?? {},
			...(lane === "modern" ? { versionNegotiation: { mode: "auto" as const } } : {}),
		},
	);
	if (options.elicit) client.setRequestHandler("elicitation/create", options.elicit);
	if (lane === "legacy-session") {
		const server = createSpotifyServer(() => spotify);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		onTestFinished(() => server.close());
	} else {
		// The handler the Worker serves, called in-process instead of over a socket.
		const handler = createMcpHandler(() => createSpotifyServer(() => spotify));
		await client.connect(
			new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		);
	}
	onTestFinished(() => client.close());
	expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(lane === "modern");
	// Discovering the tools enables the SDK client's advertised output validation.
	await client.listTools();
	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args });
	return { call, client, seen: fake.seen };
}

const track = (id: string, name: string) => ({
	id,
	name,
	artists: [{ id: "a1", name: "Artist" }],
	album: { id: "al1", name: "Album" },
});

describe.each(LANES)("registerTools over %s", (lane) => {
	const connect = (routes: Routes, options?: ConnectOptions) => connectOver(lane, routes, options);
	/** Stateless legacy HTTP keeps no session, so the server can never ask its client. */
	const canAsk = lane !== "legacy-http";

	it("keeps legacy optional fields while trimming Spotify payloads under output validation", async () => {
		const { call } = await connect({
			"GET /v1/artists/a1": () =>
				Response.json({
					id: "a1",
					name: "Artist",
					genres: ["jazz"],
					popularity: 0,
					followers: { total: 0 },
					images: [{ url: "https://example.com/cover.jpg" }],
				}),
			"GET /v1/tracks/t1": () =>
				Response.json({
					...track("t1", "One"),
					explicit: false,
					track_number: 1,
					duration_ms: 0,
					artists: [
						{ id: null, name: "Unknown ID" },
						{ id: "a1", name: "Artist" },
					],
					external_urls: { spotify: "https://open.spotify.com/track/t1" },
				}),
		});
		expect((await call("get_artist", { ids: ["a1"] })).structuredContent).toEqual({
			artists: [{ id: "a1", name: "Artist", genres: ["jazz"], popularity: 0, followers: 0 }],
		});
		expect((await call("get_tracks", { ids: ["t1"] })).structuredContent).toEqual({
			tracks: [
				{
					id: "t1",
					name: "One",
					artist: "Unknown ID, Artist",
					album: "Album",
					explicit: false,
					track_number: 1,
					duration_ms: 0,
					album_id: "al1",
					artist_ids: ["a1"],
				},
			],
		});
	});

	it("get_playlist numbers positions from offset and keeps unavailable rows", async () => {
		const { call } = await connect({
			"GET /v1/playlists/p1": () => Response.json({ id: "p1", name: "Mix", tracks: { total: 3 } }),
			"GET /v1/playlists/p1/items": (seen) => {
				expect(seen.query.get("offset")).toBe("10");
				return Response.json({
					items: [{ item: track("t1", "One") }, { item: null }, { item: track("t3", "Three") }],
					total: 13,
				});
			},
		});
		const res = await call("get_playlist", { playlist_id: "p1", offset: 10 });
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({
			total_tracks: 13,
			tracks: [
				{ position: 10, id: "t1" },
				{ position: 11, name: "Unavailable" },
				{ position: 12, id: "t3" },
			],
		});
	});

	it("check_library maps one boolean per id in order", async () => {
		const { call, seen } = await connect({
			"GET /v1/me/library/contains": () => Response.json([true, false]),
		});
		const res = await call("check_library", { kind: "track", ids: ["t1", "spotify:track:t2"] });
		expect(res.structuredContent).toEqual({
			kind: "track",
			items: [
				{ id: "t1", in_library: true },
				{ id: "spotify:track:t2", in_library: false },
			],
		});
		expect(seen[0]?.query.get("uris")).toBe("spotify:track:t1,spotify:track:t2");
	});

	it("check_library enforces the smaller album cap", async () => {
		const { call, seen } = await connect({});
		const ids = Array.from({ length: 21 }, (_, i) => `al${i}`);
		const res = await call("check_library", { kind: "album", ids });
		expect(res.isError).toBe(true);
		expect(seen).toHaveLength(0);
	});

	it("turns a scope 403 into a reconnect instruction", async () => {
		const { call } = await connect({
			"GET /v1/me/top/artists": () =>
				Response.json(
					{ error: { status: 403, message: "Insufficient client scope" } },
					{ status: 403 },
				),
		});
		const res = await call("get_top_items", { type: "artists" });
		expect(res.isError).toBe(true);
		expect(res.content).toEqual([
			{ type: "text", text: expect.stringContaining("Reconnect this MCP server") },
		]);
	});

	it("passes a 400 reason through without a retry hint, but keeps it for 5xx", async () => {
		const { call } = await connect({
			"GET /v1/me/top/artists": () =>
				Response.json({ error: { status: 400, message: "Invalid base62 id" } }, { status: 400 }),
			"GET /v1/me/top/tracks": () =>
				Response.json({ error: { status: 503, message: "Service unavailable" } }, { status: 503 }),
		});
		expect((await call("get_top_items", { type: "artists" })).content).toEqual([
			{
				type: "text",
				text: "Spotify rejected the request (HTTP 400). Spotify said: Invalid base62 id",
			},
		]);
		expect((await call("get_top_items", { type: "tracks" })).content).toEqual([
			{
				type: "text",
				text: "The request to Spotify failed (HTTP 503). Try again shortly. Spotify said: Service unavailable",
			},
		]);
	});

	it("add_to_queue accepts a share link without double-prefixing it", async () => {
		const { call, seen } = await connect({
			"POST /v1/me/player/queue": () => new Response(null, { status: 204 }),
		});
		await call("add_to_queue", {
			uri: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x",
		});
		expect(seen[0]?.query.get("uri")).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
	});

	it("treats a 200 with an opaque plain-text body as success for player writes", async () => {
		// Spotify's live answers to these, verbatim: 200, no content-type, a token.
		const { call } = await connect({
			"PUT /v1/me/player/seek": () => new Response("75Hr8PcRIYoJepokoqsdMo8ygaw", { status: 200 }),
			"POST /v1/me/player/queue": () =>
				new Response("4vqwbjpmyaaHu8O6PgcumHo8drw", { status: 200 }),
		});
		const seek = await call("control_playback", { action: "seek", position_ms: 1000 });
		expect(seek.isError).toBeUndefined();
		expect(seek.structuredContent).toMatchObject({ status: "success" });
		const queued = await call("add_to_queue", { uri: "t1" });
		expect(queued.isError).toBeUndefined();
		expect(queued.structuredContent).toMatchObject({ status: "success" });
	});

	it("play sends one target: a normalized context wins over uris", async () => {
		const { call, seen } = await connect({
			"PUT /v1/me/player/play": () => new Response(null, { status: 204 }),
		});
		await call("control_playback", {
			action: "play",
			context_uri: "https://open.spotify.com/album/1A2B?si=x",
			uris: ["t1"],
		});
		await call("control_playback", {
			action: "play",
			context_uri: "spotify:user:someone:playlist:xyz",
		});
		await call("control_playback", { action: "play", uris: ["t1"] });
		expect(seen.map((s) => s.body)).toEqual([
			{ context_uri: "spotify:album:1A2B" },
			{ context_uri: "spotify:playlist:xyz" },
			{ uris: ["spotify:track:t1"] },
		]);
	});

	it("check_library fails loudly on a short answer instead of mislabelling", async () => {
		const { call } = await connect({
			"GET /v1/me/library/contains": () => Response.json([true]),
		});
		const res = await call("check_library", { kind: "track", ids: ["t1", "t2"] });
		expect(res.isError).toBe(true);
	});

	it("rejects seek without a position before touching Spotify", async () => {
		const { call, seen } = await connect({});
		const res = await call("control_playback", { action: "seek" });
		expect(res.isError).toBe(true);
		expect(seen).toHaveLength(0);
	});

	it("uses search offset through the tool and rejects offsets outside Spotify's range", async () => {
		const { call, seen } = await connect({
			"GET /v1/search": (req) =>
				Response.json({
					tracks: { items: [track(`t${req.query.get("offset")}`, "Match")], next: null },
				}),
		});
		expect(
			(await call("search_music", { query: "test", offset: 7 })).structuredContent,
		).toMatchObject({
			tracks: [{ id: "t7" }],
		});
		expect((await call("search_music", { query: "test", offset: 1001 })).isError).toBe(true);
		expect(seen).toHaveLength(1);
	});

	it("reorder refuses a stale snapshot but remains usable without a guard", async () => {
		const { call } = await connect({
			"PUT /v1/playlists/p1/items": (req) => {
				const body = z.object({ snapshot_id: z.string().optional() }).parse(req.body);
				if (body.snapshot_id === "stale") {
					return Response.json(
						{ error: { status: 409, message: "Snapshot conflict" } },
						{ status: 409 },
					);
				}
				return Response.json({ snapshot_id: "updated" });
			},
		});
		const args = { playlist_id: "p1", range_start: 2, insert_before: 0 };
		expect((await call("reorder_playlist", { ...args, snapshot_id: "stale" })).isError).toBe(true);
		expect((await call("reorder_playlist", args)).structuredContent).toEqual({
			reordered: true,
			snapshot_id: "updated",
		});
	});

	it("returns explicit no-playback state and structured mutation acknowledgements", async () => {
		const { call } = await connect({
			"GET /v1/me/player": () => new Response(null, { status: 204 }),
			"GET /v1/me/player/queue": () => Response.json({ currently_playing: null, queue: [] }),
			"PUT /v1/me/library": () => new Response(null, { status: 204 }),
		});
		expect((await call("get_playback_state")).structuredContent).toMatchObject({
			is_playing: false,
			track: null,
		});
		expect((await call("get_queue")).structuredContent).toEqual({
			currently_playing: null,
			queue: [],
		});
		const saved = await call("save_tracks", { ids: ["t1"] });
		expect(saved.structuredContent).toMatchObject({ status: "success" });
		const acknowledgement = z.object({ message: z.string() }).parse(saved.structuredContent);
		expect(saved.content).toEqual([{ type: "text", text: acknowledgement.message }]);
	});

	it("reports active playback of an item it can't describe instead of no playback", async () => {
		const { call } = await connect({
			"GET /v1/me/player": () =>
				Response.json({
					is_playing: true,
					progress_ms: 1000,
					item: null,
					currently_playing_type: "ad",
					device: { id: "d1", name: "Phone", is_active: true },
				}),
		});
		expect((await call("get_playback_state")).structuredContent).toMatchObject({
			is_playing: true,
			track: null,
			device: { name: "Phone" },
			message: "Current item is ad; only tracks and episodes are described.",
		});
	});

	it("describes a playing or queued podcast episode with its show as the artist", async () => {
		const episode = {
			id: "e1",
			name: "Pilot",
			type: "episode",
			release_date: "2024-05-01",
			duration_ms: 3000,
			show: { id: "s1", name: "The Show" },
		};
		const { call } = await connect({
			"GET /v1/me/player": () =>
				Response.json({ is_playing: true, item: episode, currently_playing_type: "episode" }),
			"GET /v1/me/player/queue": () =>
				Response.json({ currently_playing: episode, queue: [track("t1", "Next")] }),
		});
		const described = {
			id: "e1",
			name: "Pilot",
			artist: "The Show",
			released: "2024-05-01",
			type: "episode",
			duration_ms: 3000,
		};
		expect((await call("get_playback_state")).structuredContent).toEqual({
			is_playing: true,
			track: described,
		});
		expect((await call("get_queue")).structuredContent).toEqual({
			currently_playing: described,
			queue: [{ id: "t1", name: "Next", artist: "Artist", album: "Album" }],
		});
	});

	it("refuses to queue an album as an item and points at context_uri", async () => {
		const { call, seen } = await connect({});
		const res = await call("add_to_queue", { uri: "spotify:album:al1" });
		expect(res.isError).toBe(true);
		expect(res.content).toEqual([{ type: "text", text: expect.stringContaining("context_uri") }]);
		expect(seen).toHaveLength(0);
	});

	it("fetches bounded playlist positions across short pages and reports progress", async () => {
		const { client, seen } = await connect({
			"GET /v1/playlists/p1": () => Response.json({ id: "p1", name: "Mix", snapshot_id: "s1" }),
			"GET /v1/playlists/p1/items": (req) => {
				const offset = Number(req.query.get("offset"));
				if (offset === 4)
					return Response.json({
						items: [null, { item: null, is_local: true }],
						total: 9,
						next: "more",
					});
				return Response.json({ items: [{ item: track("t6", "Six") }], total: 9, next: "more" });
			},
		});
		const progress: number[] = [];
		const res = await client.callTool(
			{
				name: "get_playlist",
				arguments: { playlist_id: "p1", offset: 4, limit: 3, fetch_all: true, max_items: 3 },
			},
			{ onprogress: (value) => progress.push(value.progress) },
		);
		expect(res.structuredContent).toMatchObject({
			playlist: { snapshot_id: "s1" },
			contents_status: "available",
			returned: 3,
			next_offset: 7,
			complete: false,
			truncated: true,
			tracks: [
				{ position: 4, name: "Unavailable" },
				{ position: 5, name: "Unavailable", is_local: true },
				{ position: 6, id: "t6" },
			],
		});
		expect(progress).toEqual([2, 3]);
		expect(seen.slice(1).map((r) => [r.query.get("offset"), r.query.get("limit")])).toEqual([
			["4", "3"],
			["6", "1"],
		]);
	});

	it("distinguishes inaccessible playlist contents from an empty playlist", async () => {
		const { call } = await connect({
			"GET /v1/playlists/locked": () =>
				Response.json({ id: "locked", name: "Locked", tracks: { total: 12 } }),
			"GET /v1/playlists/locked/items": () =>
				Response.json({ error: { status: 403, message: "Forbidden" } }, { status: 403 }),
			"GET /v1/playlists/empty": () =>
				Response.json({ id: "empty", name: "Empty", items: { total: 0 } }),
			"GET /v1/playlists/empty/items": () => Response.json({ items: [], total: 0, next: null }),
		});
		expect(
			(await call("get_playlist", { playlist_id: "locked", fetch_all: true })).structuredContent,
		).toMatchObject({
			contents_status: "inaccessible",
			total_tracks: 12,
			tracks: [],
			complete: false,
		});
		expect(
			(await call("get_playlist", { playlist_id: "empty", fetch_all: true })).structuredContent,
		).toMatchObject({
			contents_status: "available",
			total_tracks: 0,
			tracks: [],
			complete: true,
			next_offset: null,
		});
	});

	it("keeps single-page reads by default and completes legacy fetch-all reads", async () => {
		const { call } = await connect({
			"GET /v1/playlists/p1": () => Response.json({ id: "p1", name: "Mix", tracks: { total: 2 } }),
			"GET /v1/playlists/p1/tracks": (req) =>
				req.query.get("offset") === "0"
					? Response.json({ items: [{ track: track("t1", "One") }], next: "more", total: 2 })
					: Response.json({ items: [{ track: null, is_local: true }], next: null, total: 2 }),
		});
		expect(
			(await call("get_playlist", { playlist_id: "p1", limit: 1 })).structuredContent,
		).toMatchObject({
			returned: 1,
			complete: false,
			next_offset: 1,
			tracks: [{ position: 0, id: "t1" }],
		});
		expect(
			(await call("get_playlist", { playlist_id: "p1", limit: 1, fetch_all: true }))
				.structuredContent,
		).toMatchObject({
			returned: 2,
			complete: true,
			truncated: false,
			next_offset: null,
			tracks: [
				{ position: 0, id: "t1" },
				{ position: 1, name: "Unavailable", is_local: true },
			],
		});
	});

	it("stops an inconsistent empty playlist page instead of looping or claiming completeness", async () => {
		const { call, seen } = await connect({
			"GET /v1/playlists/p1": () => Response.json({ id: "p1", name: "Mix" }),
			"GET /v1/playlists/p1/items": () => Response.json({ items: [], total: 2, next: "more" }),
		});
		const result = await call("get_playlist", { playlist_id: "p1", fetch_all: true });
		expect(result.isError).toBe(true);
		expect(seen.filter((r) => r.path.endsWith("/items"))).toHaveLength(1);
	});

	it("retains partial positions and metadata when later playlist pages become inaccessible", async () => {
		const { call } = await connect({
			"GET /v1/playlists/p1": () => Response.json({ id: "p1", name: "Mix", tracks: { total: 3 } }),
			"GET /v1/playlists/p1/items": (req) =>
				req.query.get("offset") === "0"
					? Response.json({ items: [{ item: track("t1", "One") }], next: "more", total: 3 })
					: Response.json({ error: { status: 403, message: "Forbidden" } }, { status: 403 }),
		});
		expect(
			(await call("get_playlist", { playlist_id: "p1", fetch_all: true })).structuredContent,
		).toMatchObject({
			contents_status: "inaccessible",
			total_tracks: 3,
			complete: false,
			returned: 1,
			next_offset: 1,
			tracks: [{ id: "t1", position: 0 }],
		});
	});

	it
		.skipIf(!canAsk)
		.each<ElicitResult>([
			{ action: "cancel" },
			{ action: "decline" },
			{ action: "accept", content: { confirm: false } },
		])("does not remove tracks after an unconfirmed elicitation: %j", async (response) => {
		const { call, seen } = await connect(
			{},
			{ capabilities: { elicitation: { form: {} } }, elicit: () => response },
		);
		const result = await call("remove_tracks_from_playlist", { playlist_id: "p1", uris: ["t1"] });
		expect(result.structuredContent).toMatchObject({ status: "cancelled", removed: 0 });
		expect(seen).toEqual([]);
	});

	it.skipIf(!canAsk)("does not remove tracks when elicitation fails", async () => {
		// Advertised support with no handler: the client can't answer the question.
		const { call, seen } = await connect({}, { capabilities: { elicitation: { form: {} } } });
		const failed = await call("remove_tracks_from_playlist", {
			playlist_id: "p1",
			uris: ["t1"],
		}).then(
			(result) => result.isError === true,
			() => true,
		);
		expect(failed).toBe(true);
		expect(seen).toEqual([]);
	});

	// A bare `elicitation: {}` predates elicitation modes and means form support.
	it.skipIf(!canAsk).each<ClientCapabilities>([{ elicitation: { form: {} } }, { elicitation: {} }])(
		"requires explicit acceptance without code generation and returns the new snapshot: %j",
		async (capabilities) => {
			let asked = "";
			const { call } = await connect(
				{
					"DELETE /v1/playlists/p1/items": () => {
						expect(asked).toContain("Remove all occurrences of 1 track URI(s) from playlist p1?");
						return Response.json({ snapshot_id: "s2" });
					},
				},
				{
					capabilities,
					elicit: (request) => {
						asked = request.params.message;
						return { action: "accept", content: { confirm: true } };
					},
				},
			);
			vi.stubGlobal(
				"Function",
				class {
					constructor() {
						throw new EvalError("Code generation from strings disallowed for this context");
					}
				},
			);
			onTestFinished(() => {
				vi.unstubAllGlobals();
			});
			expect(
				(await call("remove_tracks_from_playlist", { playlist_id: "p1", uris: ["t1"] }))
					.structuredContent,
			).toMatchObject({
				status: "success",
				removed: 1,
				snapshot_id: "s2",
			});
		},
	);

	it.runIf(!canAsk)("removes directly because stateless legacy HTTP cannot ask", async () => {
		const elicit = vi.fn<() => ElicitResult>(() => ({ action: "decline" }));
		const { call } = await connect(
			{ "DELETE /v1/playlists/p1/items": () => Response.json({ snapshot_id: "s2" }) },
			{ capabilities: { elicitation: { form: {} } }, elicit },
		);
		expect(
			(await call("remove_tracks_from_playlist", { playlist_id: "p1", uris: ["t1"] }))
				.structuredContent,
		).toMatchObject({ status: "success", removed: 1 });
		expect(elicit).not.toHaveBeenCalled();
	});

	it.each<ClientCapabilities>([{}, { elicitation: { url: {} } }])(
		"retains direct removal without form support: %j",
		async (capabilities) => {
			const { call } = await connect(
				{
					"DELETE /v1/playlists/p1/items": () => Response.json({ snapshot_id: "s2" }),
				},
				{ capabilities },
			);
			expect(
				(await call("remove_tracks_from_playlist", { playlist_id: "p1", uris: ["t1"] }))
					.structuredContent,
			).toMatchObject({
				status: "success",
				removed: 1,
				snapshot_id: "s2",
			});
		},
	);

	// A 2025-era client cancels over stateless HTTP with a separate notification
	// that reaches a fresh server, so only the per-attempt deadline bounds that lane.
	it.skipIf(lane === "legacy-http")(
		"stops the upstream request when the client cancels",
		async () => {
			const { client, seen } = await connect({ "GET /v1/me": () => new Promise<never>(() => {}) });
			const cancel = new AbortController();
			const pending = client.callTool({ name: "get_me", arguments: {} }, { signal: cancel.signal });
			await vi.waitFor(() => expect(seen).toHaveLength(1));
			cancel.abort();
			await expect(pending).rejects.toThrow();
			await vi.waitFor(() => expect(seen[0]?.signal?.aborted).toBe(true));
		},
	);

	describe("set_playlist_cover", () => {
		const jpeg = { "Content-Type": "image/jpeg" };
		const setCover = (call: (name: string, args: Record<string, unknown>) => unknown) =>
			call("set_playlist_cover", { playlist_id: "p1", image_url: "https://example.com/c.jpg" });

		it("uploads a small JPEG as base64", async () => {
			const { call, seen } = await connect({
				"GET /c.jpg": () =>
					new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: jpeg }),
				"PUT /v1/playlists/p1/images": () => new Response(null, { status: 202 }),
			});
			expect(await setCover(call)).not.toHaveProperty("isError", true);
			expect(seen.at(-1)).toMatchObject({ contentType: "image/jpeg", body: "/9j/2Q==" });
		});

		it("stops reading an oversized body that declares no length", async () => {
			let pulls = 0;
			const endless = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(64 * 1024));
				},
			});
			const { call, seen } = await connect({
				"GET /c.jpg": () => new Response(endless, { headers: jpeg }),
			});
			expect(await setCover(call)).toMatchObject({
				isError: true,
				content: [{ text: expect.stringContaining("too big") }],
			});
			expect(pulls).toBeLessThan(10);
			expect(seen.map((s) => s.method)).toEqual(["GET"]);
		});

		it("refuses a declared oversized body without reading it", async () => {
			// Never produces a byte, so reading it would hang until the deadline.
			const silent = new ReadableStream<Uint8Array>();
			const { call } = await connect({
				"GET /c.jpg": () =>
					new Response(silent, { headers: { ...jpeg, "Content-Length": String(400 * 1024) } }),
			});
			expect(await setCover(call)).toMatchObject({
				isError: true,
				content: [{ text: expect.stringContaining("this one is 400 KB") }],
			});
		});

		it("gives up on a body that stalls past the deadline", async () => {
			const stalled = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([0xff, 0xd8]));
				},
			});
			const { call, seen } = await connect(
				{ "GET /c.jpg": () => new Response(stalled, { headers: jpeg }) },
				{ timeoutMs: 50 },
			);
			expect(await setCover(call)).toMatchObject({
				isError: true,
				content: [{ text: expect.stringContaining("timed out") }],
			});
			expect(seen.map((s) => s.method)).toEqual(["GET"]);
		});
	});
});
