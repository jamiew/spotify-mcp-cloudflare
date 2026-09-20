import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	addToQueue,
	compactPlaylist,
	compactTrack,
	controlPlayback,
	createPlaylist,
	followArtists,
	getAlbums,
	getArtists,
	getPlaylistTracks,
	getSavedAlbums,
	getSavedTracks,
	getTracks,
	libraryContains,
	removePlaylistTracks,
	reorderPlaylistTracks,
	saveTracks,
	search,
	setPlaylistCover,
} from "./endpoints";
import { fakeSpotify, type SeenRequest, staticTokens } from "./fake-spotify";
import { SpotifyClient } from "./spotify";

function makeClient(routes: Record<string, (seen: SeenRequest) => Response>) {
	const fake = fakeSpotify(routes);
	const client = new SpotifyClient({
		tokenProvider: staticTokens(),
		fetchImpl: fake.fetchImpl,
		sleep: async () => {},
	});
	return { client, seen: fake.seen };
}

const track = (id: string, name: string) => ({
	id,
	name,
	artists: [{ id: "a1", name: "Artist" }],
	album: { id: "al1", name: "Album", release_date: "2020-01-01" },
	duration_ms: 1000,
});

const notFound = () =>
	Response.json({ error: { status: 404, message: "Service not found" } }, { status: 404 });

describe("search", () => {
	it("paginates each type at the 10-per-request cap and merges pages", async () => {
		const { client, seen } = makeClient({
			"GET /v1/search": (req) => {
				const offset = Number(req.query.get("offset") ?? "0");
				const items = Array.from({ length: Number(req.query.get("limit")) }, (_, i) =>
					track(`t${offset + i}`, `Track ${offset + i}`),
				);
				return Response.json({ tracks: { items, next: "more" } });
			},
		});
		const res = await search(client, "test", ["track"], 15);
		expect(res.tracks?.length).toBe(15);
		expect(seen.map((s) => s.query.get("offset"))).toEqual(["0", "10"]);
		expect(seen.map((s) => s.query.get("limit"))).toEqual(["10", "5"]);
	});

	it("drops null entries Spotify sometimes returns in search pages", async () => {
		const { client } = makeClient({
			"GET /v1/search": () =>
				Response.json({ playlists: { items: [null, { id: "p1", name: "P" }], next: null } }),
		});
		const res = await search(client, "test", ["playlist"], 10);
		expect(res.playlists?.map((p) => p.id)).toEqual(["p1"]);
	});

	it("starts every search type at the requested offset and counts null positions before filtering", async () => {
		const { client, seen } = makeClient({
			"GET /v1/search": (req) => {
				const offset = Number(req.query.get("offset"));
				const items = Array.from({ length: Number(req.query.get("limit")) }, (_, i) =>
					i === 0 ? null : track(`t${offset + i}`, `Track ${offset + i}`),
				);
				return Response.json({
					[req.query.get("type") === "track" ? "tracks" : "albums"]: { items, next: "more" },
				});
			},
		});
		const result = await search(client, "test", ["track", "album"], 12, 17);
		expect(result.tracks?.map((item) => item.id)).toEqual([
			"t18",
			"t19",
			"t20",
			"t21",
			"t22",
			"t23",
			"t24",
			"t25",
			"t26",
			"t28",
		]);
		expect(result.albums?.map((item) => item.id)).toEqual(result.tracks?.map((item) => item.id));
		expect(
			seen.map((r) => [r.query.get("type"), r.query.get("offset"), r.query.get("limit")]),
		).toEqual([
			["track", "17", "10"],
			["track", "27", "2"],
			["album", "17", "10"],
			["album", "27", "2"],
		]);
	});

	it("never follows search pagination beyond Spotify's maximum starting offset", async () => {
		const { client, seen } = makeClient({
			"GET /v1/search": (req) =>
				Response.json({
					tracks: {
						items: Array.from({ length: Number(req.query.get("limit")) }, (_, i) =>
							track(`t${Number(req.query.get("offset")) + i}`, "Track"),
						),
						next: "more",
					},
				}),
		});
		const result = await search(client, "test", ["track"], 50, 990);
		expect(result.tracks?.map((item) => item.id)).toEqual(
			Array.from({ length: 20 }, (_, i) => `t${990 + i}`),
		);
		expect(seen.map((r) => r.query.get("offset"))).toEqual(["990", "1000"]);
	});
});

describe("getPlaylistTracks", () => {
	it("reads the restricted /items path and normalizes the item field", async () => {
		const { client } = makeClient({
			"GET /v1/playlists/p1/items": () =>
				Response.json({
					items: [
						{ added_at: "2024-01-01", item: track("t1", "One") },
						{ added_at: null, item: null },
					],
					total: 2,
				}),
		});
		const res = await getPlaylistTracks(client, "spotify:playlist:p1");
		expect(res.tracks.map((t) => t.name)).toEqual(["One", "Unavailable"]);
		expect(res.addedAt).toEqual(["2024-01-01", null]);
		expect(res.total).toBe(2);
	});

	it("keeps null and local rows in place so positions stay aligned", async () => {
		const { client } = makeClient({
			"GET /v1/playlists/p1/items": () =>
				Response.json({
					items: [
						{ item: null, is_local: true },
						{ item: { ...track("t1", "Ripped"), id: null, is_local: true } },
						{ item: track("t2", "Two") },
					],
					total: 3,
				}),
		});
		const res = await getPlaylistTracks(client, "p1");
		expect(res.tracks.map(compactTrack)).toEqual([
			{ name: "Unavailable", artist: "unknown", is_local: true },
			{
				name: "Ripped",
				artist: "Artist",
				album: "Album",
				released: "2020-01-01",
				duration_ms: 1000,
				is_local: true,
			},
			{
				id: "t2",
				name: "Two",
				artist: "Artist",
				album: "Album",
				released: "2020-01-01",
				duration_ms: 1000,
			},
		]);
	});

	it("falls back to the legacy /tracks path with the legacy track field", async () => {
		const { client, seen } = makeClient({
			"GET /v1/playlists/p1/items": notFound,
			"GET /v1/playlists/p1/tracks": () =>
				Response.json({ items: [{ added_at: "2020-05-05", track: track("t2", "Two") }], total: 1 }),
		});
		const res = await getPlaylistTracks(client, "p1");
		expect(res.tracks.map((t) => t.name)).toEqual(["Two"]);
		expect(seen.map((s) => s.path)).toEqual(["/v1/playlists/p1/items", "/v1/playlists/p1/tracks"]);
	});

	it("preserves null rows and entry-level local flags in legacy contents", async () => {
		const { client } = makeClient({
			"GET /v1/playlists/p1/items": notFound,
			"GET /v1/playlists/p1/tracks": () =>
				Response.json({
					items: [null, { is_local: true, track: { ...track("t1", "Local"), id: null } }],
					next: null,
				}),
		});
		const page = await getPlaylistTracks(client, "p1");
		expect(page.tracks.map(compactTrack)).toMatchObject([
			{ name: "Unavailable" },
			{ name: "Local", is_local: true },
		]);
		expect(page.hasNext).toBe(false);
	});
});

describe("getTracks", () => {
	const forbidden = () =>
		Response.json({ error: { status: 403, message: "Forbidden" } }, { status: 403 });

	it("reads several ids in one batch request and drops unknown ids", async () => {
		const { client, seen } = makeClient({
			"GET /v1/tracks": () => Response.json({ tracks: [track("t1", "One"), null] }),
		});
		const res = await getTracks(client, ["t1", "spotify:track:t9"]);
		expect(res.map((t) => t.name)).toEqual(["One"]);
		expect(seen.map((s) => `${s.path}?${s.query}`)).toEqual(["/v1/tracks?ids=t1%2Ct9"]);
	});

	it("never batches a single id", async () => {
		const { client, seen } = makeClient({
			"GET /v1/tracks/t1": () => Response.json(track("t1", "One")),
		});
		await getTracks(client, ["t1"]);
		expect(seen.map((s) => s.path)).toEqual(["/v1/tracks/t1"]);
	});

	it("falls back to one request per id on 403 and remembers it", async () => {
		const { client, seen } = makeClient({
			"GET /v1/tracks": forbidden,
			"GET /v1/tracks/t1": () => Response.json(track("t1", "One")),
			"GET /v1/tracks/t2": () => Response.json(track("t2", "Two")),
		});
		expect((await getTracks(client, ["t1", "t2"])).map((t) => t.name)).toEqual(["One", "Two"]);
		expect((await getTracks(client, ["t1", "t2"])).map((t) => t.name)).toEqual(["One", "Two"]);
		expect(seen.map((s) => s.path)).toEqual([
			"/v1/tracks",
			"/v1/tracks/t1",
			"/v1/tracks/t2",
			"/v1/tracks/t1",
			"/v1/tracks/t2",
		]);
	});

	it("propagates any other batch failure", async () => {
		const { client } = makeClient({
			"GET /v1/tracks": () =>
				Response.json({ error: { status: 500, message: "boom" } }, { status: 500 }),
		});
		await expect(getTracks(client, ["t1", "t2"])).rejects.toThrow("500");
	});
});

describe("getArtists and getAlbums", () => {
	it("batch through their own routes and cache a 403 fallback per kind", async () => {
		const { client, seen } = makeClient({
			"GET /v1/artists": () => Response.json({ artists: [{ id: "a1", name: "A" }, null] }),
			"GET /v1/albums": () =>
				Response.json({ error: { status: 403, message: "Forbidden" } }, { status: 403 }),
			"GET /v1/albums/al1": () => Response.json({ id: "al1", name: "One" }),
			"GET /v1/albums/al2": () => Response.json({ id: "al2", name: "Two" }),
		});
		expect((await getArtists(client, ["a1", "a9"])).map((a) => a.name)).toEqual(["A"]);
		expect((await getAlbums(client, ["al1", "al2"])).map((a) => a.name)).toEqual(["One", "Two"]);
		expect((await getArtists(client, ["a1", "a9"])).map((a) => a.name)).toEqual(["A"]);
		expect(seen.map((s) => s.path)).toEqual([
			"/v1/artists",
			"/v1/albums",
			"/v1/albums/al1",
			"/v1/albums/al2",
			"/v1/artists",
		]);
	});
});

describe("libraryContains", () => {
	it("asks /me/library/contains by uri, falling back to the legacy per-kind routes", async () => {
		const { client, seen } = makeClient({
			"GET /v1/me/library/contains": () =>
				Response.json({ error: { status: 400, message: "Bad request" } }, { status: 400 }),
			"GET /v1/me/following/contains": () => Response.json([true]),
			"GET /v1/me/albums/contains": () => Response.json([false, true]),
		});
		expect(await libraryContains(client, "artist", ["spotify:artist:a1"])).toEqual([true]);
		expect(await libraryContains(client, "album", ["al1", "al2"])).toEqual([false, true]);
		expect(seen.map((s) => `${s.path}?${s.query}`)).toEqual([
			"/v1/me/library/contains?uris=spotify%3Aartist%3Aa1",
			"/v1/me/following/contains?ids=a1&type=artist",
			"/v1/me/albums/contains?ids=al1%2Cal2",
		]);
	});
});

describe("removePlaylistTracks", () => {
	it("keys the DELETE body off items (restricted) vs tracks (legacy)", async () => {
		const { client, seen } = makeClient({
			"DELETE /v1/playlists/p1/items": notFound,
			"DELETE /v1/playlists/p1/tracks": () => Response.json({ snapshot_id: "snap" }),
		});
		const snapshot = await removePlaylistTracks(client, "p1", ["spotify:track:t1"]);
		expect(snapshot).toBe("snap");
		expect(seen[0]?.body).toEqual({ items: [{ uri: "spotify:track:t1" }] });
		expect(seen[1]?.body).toEqual({ tracks: [{ uri: "spotify:track:t1" }] });
	});
});

describe("reorderPlaylistTracks", () => {
	it.each(["items", "tracks"])("guards concurrent edits on the %s route", async (route) => {
		const { client } = makeClient({
			...(route === "tracks" ? { "PUT /v1/playlists/p1/items": notFound } : {}),
			[`PUT /v1/playlists/p1/${route}`]: (req) => {
				const body = z.object({ snapshot_id: z.string().optional() }).parse(req.body);
				if (body.snapshot_id !== "current") {
					return Response.json(
						{ error: { status: 409, message: "Snapshot conflict" } },
						{ status: 409 },
					);
				}
				return Response.json({ snapshot_id: "updated" });
			},
		});
		await expect(
			reorderPlaylistTracks(client, "p1", {
				rangeStart: 2,
				insertBefore: 0,
				snapshotId: "stale",
			}),
		).rejects.toMatchObject({ status: 409 });
		expect(
			await reorderPlaylistTracks(client, "p1", {
				rangeStart: 2,
				insertBefore: 0,
				snapshotId: "current",
			}),
		).toBe("updated");
	});
});

describe("createPlaylist", () => {
	it("POSTs to /me/playlists in the restricted regime", async () => {
		const { client, seen } = makeClient({
			"POST /v1/me/playlists": () => Response.json({ id: "p9", name: "New" }),
		});
		const playlist = await createPlaylist(client, { name: "New", isPublic: false });
		expect(playlist.id).toBe("p9");
		expect(seen[0]?.body).toMatchObject({ name: "New", public: false });
	});

	it("falls back to /users/{id}/playlists using the fetched user id", async () => {
		const { client, seen } = makeClient({
			"POST /v1/me/playlists": notFound,
			"GET /v1/me": () => Response.json({ id: "jamie" }),
			"POST /v1/users/jamie/playlists": () => Response.json({ id: "p10", name: "Legacy" }),
		});
		const playlist = await createPlaylist(client, { name: "Legacy" });
		expect(playlist.id).toBe("p10");
		expect(seen.map((s) => s.path)).toEqual([
			"/v1/me/playlists",
			"/v1/me",
			"/v1/users/jamie/playlists",
		]);
	});
});

describe("saveTracks", () => {
	it("PUTs uris to /me/library, falling back to legacy /me/tracks ids", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/me/library": notFound,
			"PUT /v1/me/tracks": () => new Response(null, { status: 200 }),
		});
		await saveTracks(client, ["t1", "spotify:track:t2"]);
		expect(seen[0]?.query.get("uris")).toBe("spotify:track:t1,spotify:track:t2");
		expect(seen[0]?.body).toBeUndefined();
		expect(seen[1]?.body).toEqual({ ids: ["t1", "t2"] });
	});
});

describe("getSavedTracks", () => {
	it("normalizes legacy track and restricted item entries", async () => {
		const { client } = makeClient({
			"GET /v1/me/tracks": () =>
				Response.json({
					items: [
						{ added_at: "2023-01-01", track: track("t1", "Legacy Shape") },
						{ added_at: "2024-01-01", item: track("t2", "Restricted Shape") },
					],
					total: 2,
				}),
		});
		const res = await getSavedTracks(client);
		expect(res.tracks.map((t) => t.name)).toEqual(["Legacy Shape", "Restricted Shape"]);
	});
});

describe("controlPlayback", () => {
	it("sets shuffle via query param", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/me/player/shuffle": () => new Response(null, { status: 204 }),
		});
		await controlPlayback(client, { action: "shuffle", state: true }, "dev1");
		expect(seen[0]?.query.get("state")).toBe("true");
		expect(seen[0]?.query.get("device_id")).toBe("dev1");
	});

	it("sets repeat mode via query param", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/me/player/repeat": () => new Response(null, { status: 204 }),
		});
		await controlPlayback(client, { action: "repeat", state: "context" });
		expect(seen[0]?.query.get("state")).toBe("context");
	});

	it("normalizes bare track ids in play uris", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/me/player/play": () => new Response(null, { status: 204 }),
		});
		await controlPlayback(client, { action: "play", uris: ["t1"] });
		expect(seen[0]?.body).toEqual({ uris: ["spotify:track:t1"] });
	});
});

describe("addToQueue", () => {
	it("normalizes a bare id into a track uri", async () => {
		const { client, seen } = makeClient({
			"POST /v1/me/player/queue": () => new Response(null, { status: 204 }),
		});
		await addToQueue(client, "t1");
		expect(seen[0]?.query.get("uri")).toBe("spotify:track:t1");
	});
});

describe("compact mappers", () => {
	it("compactTrack joins artists and drops empty fields", () => {
		expect(compactTrack(track("t1", "Song"))).toEqual({
			id: "t1",
			name: "Song",
			artist: "Artist",
			album: "Album",
			released: "2020-01-01",
			duration_ms: 1000,
		});
	});

	it("compactPlaylist reads the track count from either regime field", () => {
		const base = { id: "p1", name: "P", owner: { display_name: "Jamie" } };
		expect(compactPlaylist({ ...base, items: { total: 5 } })).toMatchObject({ track_count: 5 });
		expect(compactPlaylist({ ...base, tracks: { total: 7 } })).toMatchObject({ track_count: 7 });
	});
});

describe("getSavedAlbums", () => {
	it("normalizes legacy album and restricted item entries", async () => {
		const { client } = makeClient({
			"GET /v1/me/albums": () =>
				Response.json({
					items: [
						{ added_at: "2023-01-01", album: { id: "al1", name: "Legacy Shape" } },
						{ added_at: "2024-01-01", item: { id: "al2", name: "Restricted Shape" } },
					],
					total: 2,
				}),
		});
		const res = await getSavedAlbums(client);
		expect(res.albums.map((a) => a.name)).toEqual(["Legacy Shape", "Restricted Shape"]);
		expect(res.addedAt).toEqual(["2023-01-01", "2024-01-01"]);
	});
});

describe("followArtists", () => {
	it("PUTs uris to /me/library, falling back to legacy /me/following ids", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/me/library": notFound,
			"PUT /v1/me/following": () => new Response(null, { status: 204 }),
		});
		await followArtists(client, ["a1", "spotify:artist:a2"]);
		expect(seen[0]?.query.get("uris")).toBe("spotify:artist:a1,spotify:artist:a2");
		expect(seen[1]?.body).toEqual({ ids: ["a1", "a2"] });
		expect(seen[1]?.query.get("type")).toBe("artist");
	});
});

describe("setPlaylistCover", () => {
	it("sends the base64 body verbatim as image/jpeg rather than JSON", async () => {
		const { client, seen } = makeClient({
			"PUT /v1/playlists/p1/images": () => new Response(null, { status: 202 }),
		});
		await setPlaylistCover(client, "spotify:playlist:p1", "/9j/BASE64");
		expect(seen[0]?.body).toBe("/9j/BASE64");
		expect(seen[0]?.contentType).toBe("image/jpeg");
	});
});
