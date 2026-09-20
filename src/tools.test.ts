// Drives the real tool surface over an in-memory MCP transport with a fake
// Spotify behind it, so argument validation, error mapping and output shaping
// are exercised the way a client sees them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	type ClientCapabilities,
	ElicitRequestSchema,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { fakeSpotify, type SeenRequest, staticTokens } from "./fake-spotify";
import { createSpotifyServer } from "./server";
import { SpotifyClient } from "./spotify";

async function connect(
	routes: Record<string, (seen: SeenRequest) => Response>,
	options: {
		capabilities?: ClientCapabilities;
		elicit?: () => ElicitResult | Promise<ElicitResult>;
	} = {},
) {
	const fake = fakeSpotify(routes);
	const spotify = new SpotifyClient({
		tokenProvider: staticTokens(),
		fetchImpl: fake.fetchImpl,
		sleep: async () => {},
	});
	const server = createSpotifyServer(() => spotify);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "test-client", version: "0" },
		{ capabilities: options.capabilities ?? {} },
	);
	if (options.elicit) client.setRequestHandler(ElicitRequestSchema, options.elicit);
	await client.connect(clientTransport);
	onTestFinished(async () => {
		await client.close();
		await server.close();
	});
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

describe("registerTools", () => {
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

	it("add_to_queue accepts a share link without double-prefixing it", async () => {
		const { call, seen } = await connect({
			"POST /v1/me/player/queue": () => new Response(null, { status: 204 }),
		});
		await call("add_to_queue", {
			uri: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x",
		});
		expect(seen[0]?.query.get("uri")).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
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
			undefined,
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

	it.each<ElicitResult>([
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

	it("does not remove tracks when elicitation fails", async () => {
		const { call, seen } = await connect(
			{},
			{
				// Advertised support with no handler yields a real MCP MethodNotFound error.
				capabilities: { elicitation: { form: {} } },
			},
		);
		expect(
			(await call("remove_tracks_from_playlist", { playlist_id: "p1", uris: ["t1"] })).isError,
		).toBe(true);
		expect(seen).toEqual([]);
	});

	it("requires explicit acceptance without code generation and returns the new snapshot", async () => {
		let confirmed = false;
		const { call } = await connect(
			{
				"DELETE /v1/playlists/p1/items": () => {
					expect(confirmed).toBe(true);
					return Response.json({ snapshot_id: "s2" });
				},
			},
			{
				capabilities: { elicitation: { form: {} } },
				elicit: () => {
					confirmed = true;
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
});
