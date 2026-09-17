// Drives the real tool surface over an in-memory MCP transport with a fake
// Spotify behind it, so argument validation, error mapping and output shaping
// are exercised the way a client sees them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { fakeSpotify, type SeenRequest, staticTokens } from "./fake-spotify";
import { SpotifyClient } from "./spotify";
import { registerTools } from "./tools";

async function connect(routes: Record<string, (seen: SeenRequest) => Response>) {
	const fake = fakeSpotify(routes);
	const spotify = new SpotifyClient({
		tokenProvider: staticTokens(),
		fetchImpl: fake.fetchImpl,
		sleep: async () => {},
	});
	const server = new McpServer({ name: "test", version: "0" });
	registerTools(server, () => spotify);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "0" });
	await client.connect(clientTransport);
	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args });
	return { call, seen: fake.seen };
}

const track = (id: string, name: string) => ({
	id,
	name,
	artists: [{ id: "a1", name: "Artist" }],
	album: { id: "al1", name: "Album" },
});

describe("registerTools", () => {
	it("registers every tool with a title and behaviour annotations", async () => {
		const server = new McpServer({ name: "t", version: "0" });
		registerTools(server, () => {
			throw new Error("unused");
		});
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.length).toBeGreaterThan(30);
		for (const tool of tools) {
			expect(tool.title, tool.name).toBeTruthy();
			expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean");
		}
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

	it("rejects seek without a position before touching Spotify", async () => {
		const { call, seen } = await connect({});
		const res = await call("control_playback", { action: "seek" });
		expect(res.isError).toBe(true);
		expect(seen).toHaveLength(0);
	});
});
