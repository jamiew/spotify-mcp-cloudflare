// The MCP tool and prompt surface. Kept apart from the Durable Object in
// index.ts so it can be driven in-process by tests with a fake Spotify.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	addPlaylistTracks,
	addToQueue,
	BATCH_MAX,
	CONTAINS_MAX,
	compactAlbum,
	compactArtist,
	compactPlaylist,
	compactTrack,
	controlPlayback,
	createPlaylist,
	followArtists,
	followPlaylist,
	getAlbums,
	getArtistAlbums,
	getArtists,
	getDevices,
	getFollowedArtists,
	getMe,
	getMyPlaylists,
	getPlaybackState,
	getPlaylist,
	getPlaylistTracks,
	getQueue,
	getRecentlyPlayed,
	getSavedAlbums,
	getSavedTracks,
	getTopArtists,
	getTopTracks,
	getTracks,
	LIBRARY_WRITE_MAX,
	libraryContains,
	removePlaylistTracks,
	removeSavedAlbums,
	removeSavedTracks,
	reorderPlaylistTracks,
	type SearchType,
	saveAlbums,
	saveTracks,
	search,
	setPlaylistCover,
	transferPlayback,
	unfollowArtists,
	unfollowPlaylist,
	updatePlaylistDetails,
} from "./endpoints";
import {
	isNoActiveDeviceError,
	isPremiumRequiredError,
	RateLimitedError,
	ResponseShapeError,
	SpotifyApiError,
	SpotifyAuthError,
	type SpotifyClient,
	toUri,
} from "./spotify";

// Sent once at initialize. Covers what the tool descriptions can't say
// individually: how the surface fits together, and which Spotify capabilities
// are simply gone.
export const INSTRUCTIONS = `Spotify for the signed-in user. Tracks, albums, artists and playlists are accepted as bare IDs, spotify: URIs or open.spotify.com links anywhere.

Start from search_music to turn names into IDs. get_playlist returns zero-based positions, which reorder_playlist and remove_tracks_from_playlist need. Playback tools need Spotify Premium and an open device; if none is active, list_devices then transfer_playback.

The library splits by kind. Tracks: get_saved_tracks, save_tracks, remove_saved_tracks. Albums: get_saved_albums, save_albums, remove_saved_albums. Artists are followed rather than saved: get_followed_artists, follow_artists, unfollow_artists. Playlists too: follow_playlist, unfollow_playlist — and unfollowing one you own is how Spotify deletes it.

get_tracks, get_artist and get_album each take up to 50 IDs (20 for albums) in one call. check_library says whether tracks or albums are saved and artists followed, so use it before a bulk save or follow instead of paging the library.

For an artist, get_artist is the profile and get_artist_albums is the discography; Spotify no longer offers their top tracks, so use search_music with an artist: filter for those. set_playlist_cover replaces a playlist's artwork from a URL, which must serve a JPEG of at most 256 KB.

Spotify has withdrawn /recommendations, audio-features and related-artists from third-party apps, so there is no recommendation endpoint to call. Build suggestions from get_top_items and get_recently_played plus search_music instead.

Newly created playlists may read back as public even when created private; that is Spotify's reporting, not a failed write.`;

type ToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

const ok = (structured: Record<string, unknown>): ToolResult => ({
	content: [{ type: "text", text: JSON.stringify(structured) }],
	structuredContent: structured,
});
const okText = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const toolError = (message: string): ToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

// Raw Spotify error bodies never reach the model; every failure becomes a
// short, actionable sentence.
function mapError(e: unknown): ToolResult {
	if (e instanceof SpotifyAuthError || e instanceof RateLimitedError) {
		return toolError(e.message);
	}
	if (isPremiumRequiredError(e)) {
		return toolError("This action requires Spotify Premium.");
	}
	if (isNoActiveDeviceError(e)) {
		return toolError(
			"No active Spotify device. Open Spotify on a device, or use list_devices and pass a device_id (or transfer_playback).",
		);
	}
	if (e instanceof ResponseShapeError) {
		return toolError("Spotify returned data in an unexpected shape; this tool may be degraded.");
	}
	if (e instanceof SpotifyApiError) {
		if (e.status === 404 || e.status === 410) {
			return toolError(
				"Spotify could not find that resource — the ID may be wrong, or Spotify no longer offers this capability to third-party apps.",
			);
		}
		// Spotify's own reason is the only way to tell a bad ID from a missing
		// scope from a retired endpoint, so never swallow it.
		const detail = e.reason ? ` Spotify said: ${e.reason}` : "";
		if (e.status === 403) {
			// A scope this server now requests but the stored grant predates.
			if ((e.reason ?? "").toLowerCase().includes("scope")) {
				return toolError(
					`This tool needs a Spotify permission the current login doesn't have. Reconnect this MCP server to Spotify to re-authorize.${detail}`,
				);
			}
			return toolError(
				`Spotify refused this action (forbidden). The account may lack access.${detail}`,
			);
		}
		return toolError(
			`The request to Spotify failed (HTTP ${e.status}). Try again shortly.${detail}`,
		);
	}
	return toolError(e instanceof Error ? e.message : String(e));
}

/** Spotify's documented cap, counted against the base64 payload rather than the file. */
const COVER_MAX_BASE64_CHARS = 256 * 1024;

/**
 * Cover art goes up as base64, which no model can plausibly emit as a tool
 * argument, so the tool takes a URL and the Worker does the encoding.
 */
async function fetchCoverAsBase64(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Could not fetch that image (HTTP ${response.status}).`);
	}
	const contentType = response.headers.get("Content-Type") ?? "";
	if (!contentType.startsWith("image/jpeg")) {
		throw new Error(
			`Spotify only accepts JPEG cover art, but that URL served "${contentType || "an unknown type"}".`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	// Chunked: spreading 256 KB of bytes into String.fromCharCode blows the stack.
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	const base64 = btoa(binary);
	if (base64.length > COVER_MAX_BASE64_CHARS) {
		throw new Error(
			`That image is too big: Spotify caps covers at 256 KB encoded, this one is ${Math.round(base64.length / 1024)} KB.`,
		);
	}
	return base64;
}

/** Wraps a tool handler so thrown errors become friendly MCP error results. */
function guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
	return async (args: A) => {
		try {
			return await fn(args);
		} catch (e) {
			return mapError(e);
		}
	};
}

// MCP behaviour hints, named by what they mean to a client deciding whether
// to confirm with the user. Destructive means overwrites or deletes existing
// data, not merely "writes".
const readOnly = { readOnlyHint: true, openWorldHint: false };
const lookup = { readOnlyHint: true, openWorldHint: true };
const additive = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};
const additiveIdempotent = { ...additive, idempotentHint: true };
const destructive = { ...additive, destructiveHint: true, idempotentHint: true };
const destructiveOnce = { ...destructive, idempotentHint: false };

export function registerTools(server: McpServer, sp: () => SpotifyClient) {
	server.registerTool(
		"get_me",
		{
			title: "Spotify profile",
			description:
				"Get the current user's Spotify profile. Some fields (email, country, product) are unavailable for newer Spotify apps.",
			inputSchema: {},
			annotations: readOnly,
		},
		guard(async () => {
			const me = await getMe(sp());
			return ok({
				id: me.id,
				...(me.display_name ? { display_name: me.display_name } : {}),
				...(me.email ? { email: me.email } : {}),
				...(me.country ? { country: me.country } : {}),
				...(me.product ? { product: me.product } : {}),
			});
		}),
	);

	server.registerTool(
		"search_music",
		{
			title: "Search Spotify",
			description:
				"Search Spotify for tracks, albums, artists and/or playlists. Returns compact per-type results with names and IDs.",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe("Search query. Supports Spotify field filters like artist:, album:, year:"),
				types: z
					.array(z.enum(["track", "album", "artist", "playlist"]))
					.default(["track"])
					.describe("Item types to search (default: track only)"),
				limit: z.number().int().min(1).max(50).default(10).describe("Max results per type"),
			},
			annotations: lookup,
		},
		guard(async ({ query, types, limit }) => {
			const res = await search(sp(), query, types as SearchType[], limit);
			return ok({
				...(res.tracks ? { tracks: res.tracks.map(compactTrack) } : {}),
				...(res.artists ? { artists: res.artists.map(compactArtist) } : {}),
				...(res.albums ? { albums: res.albums.map(compactAlbum) } : {}),
				...(res.playlists ? { playlists: res.playlists.map(compactPlaylist) } : {}),
			});
		}),
	);

	server.registerTool(
		"get_tracks",
		{
			title: "Track details",
			description: "Get details for one or more tracks by ID (max 50 per call).",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(BATCH_MAX.tracks)
					.describe("Track IDs or spotify:track: URIs"),
			},
			annotations: lookup,
		},
		guard(async ({ ids }) => {
			const tracks = await getTracks(sp(), ids);
			return ok({
				tracks: tracks.map((t) => ({
					...compactTrack(t),
					...(t.explicit != null ? { explicit: t.explicit } : {}),
					...(t.track_number != null ? { track_number: t.track_number } : {}),
					...(t.album?.id ? { album_id: t.album.id } : {}),
					...(t.artists?.length ? { artist_ids: t.artists.map((a) => a.id).filter(Boolean) } : {}),
				})),
			});
		}),
	);

	server.registerTool(
		"get_artist",
		{
			title: "Artist details",
			description:
				"Get details for one or more artists (max 50 per call): name, genres, followers, popularity. Spotify no longer offers top tracks; use search_music with an artist: filter for those.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(BATCH_MAX.artists)
					.describe("Artist IDs or spotify:artist: URIs"),
			},
			annotations: lookup,
		},
		guard(async ({ ids }) => ok({ artists: (await getArtists(sp(), ids)).map(compactArtist) })),
	);

	server.registerTool(
		"get_artist_albums",
		{
			title: "Artist discography",
			description:
				"List an artist's albums, newest first by default. Filter by group to separate studio albums from singles, compilations or guest appearances.",
			inputSchema: {
				id: z.string().describe("Artist ID or spotify:artist: URI"),
				include_groups: z
					.array(z.enum(["album", "single", "appears_on", "compilation"]))
					.optional()
					.describe("Release types to include (default: all)"),
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0),
			},
			annotations: lookup,
		},
		guard(async ({ id, include_groups, limit, offset }) => {
			const page = await getArtistAlbums(sp(), id, {
				...(include_groups ? { includeGroups: include_groups } : {}),
				limit,
				offset,
			});
			return ok({ total: page.total, offset, albums: page.items.map(compactAlbum) });
		}),
	);

	server.registerTool(
		"get_album",
		{
			title: "Album details",
			description:
				"Get details for one or more albums (max 20 per call), each with its track list.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(BATCH_MAX.albums)
					.describe("Album IDs or spotify:album: URIs"),
			},
			annotations: lookup,
		},
		guard(async ({ ids }) => {
			const albums = await getAlbums(sp(), ids);
			return ok({
				albums: albums.map((album) => ({
					...compactAlbum(album),
					...(album.album_type ? { album_type: album.album_type } : {}),
					tracks: (album.tracks?.items ?? []).map((t) => ({
						...compactTrack(t),
						...(t.track_number != null ? { track_number: t.track_number } : {}),
					})),
				})),
			});
		}),
	);

	server.registerTool(
		"list_playlists",
		{
			title: "Your playlists",
			description: "List the current user's playlists: name, id, track count, owner.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0),
			},
			annotations: readOnly,
		},
		guard(async ({ limit, offset }) => {
			const page = await getMyPlaylists(sp(), { limit, offset });
			return ok({
				total: page.total,
				offset,
				playlists: page.items.map(compactPlaylist),
			});
		}),
	);

	server.registerTool(
		"get_playlist",
		{
			title: "Playlist contents",
			description:
				"Get a playlist's details and a page of its tracks, with zero-based positions (needed for reordering/removal). Unavailable and local tracks keep their position but have no id. Spotify only returns contents for playlists the user owns, collaborates on, or follows.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or spotify:playlist: URI"),
				limit: z.number().int().min(1).max(50).default(50),
				offset: z.number().int().min(0).default(0).describe("Index of the first track"),
			},
			annotations: lookup,
		},
		guard(async ({ playlist_id, limit, offset }) => {
			const details = await getPlaylist(sp(), playlist_id);
			const page = await getPlaylistTracks(sp(), playlist_id, { limit, offset });
			return ok({
				playlist: compactPlaylist(details),
				total_tracks: page.total,
				offset,
				tracks: page.tracks.map((t, i) => ({ position: offset + i, ...compactTrack(t) })),
			});
		}),
	);

	server.registerTool(
		"create_playlist",
		{
			title: "Create playlist",
			description: "Create a new playlist for the current user.",
			inputSchema: {
				name: z.string().min(1).describe("Name of the new playlist"),
				description: z.string().optional().describe("Playlist description"),
				public: z.boolean().default(false).describe("Whether the playlist is public"),
				collaborative: z
					.boolean()
					.default(false)
					.describe("Whether the playlist is collaborative (requires public=false)"),
			},
			annotations: additive,
		},
		guard(async ({ name, description, public: isPublic, collaborative }) => {
			const playlist = await createPlaylist(sp(), {
				name,
				...(description !== undefined ? { description } : {}),
				isPublic,
				collaborative,
			});
			return ok(compactPlaylist(playlist));
		}),
	);

	server.registerTool(
		"update_playlist_details",
		{
			title: "Edit playlist details",
			description: "Update a playlist's name, description or public state.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or URI"),
				name: z.string().optional().describe("New name"),
				description: z.string().optional().describe("New description"),
				public: z.boolean().optional().describe("New public state"),
			},
			annotations: destructive,
		},
		guard(async ({ playlist_id, name, description, public: isPublic }) => {
			if (name === undefined && description === undefined && isPublic === undefined) {
				return toolError("Nothing to update - provide name, description or public.");
			}
			await updatePlaylistDetails(sp(), playlist_id, {
				...(name !== undefined ? { name } : {}),
				...(description !== undefined ? { description } : {}),
				...(isPublic !== undefined ? { isPublic } : {}),
			});
			return okText("Playlist updated.");
		}),
	);

	server.registerTool(
		"add_tracks_to_playlist",
		{
			title: "Add tracks to playlist",
			description: "Add tracks to a playlist, optionally at a specific position.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or URI"),
				uris: z
					.array(z.string())
					.min(1)
					.max(100)
					.describe("Track IDs or spotify:track: URIs to add"),
				position: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Zero-based position to insert at (default: append)"),
			},
			annotations: additive,
		},
		guard(async ({ playlist_id, uris, position }) => {
			const fullUris = uris.map((u) => toUri("track", u));
			const snapshot = await addPlaylistTracks(sp(), playlist_id, fullUris, position);
			return ok({ added: fullUris.length, ...(snapshot ? { snapshot_id: snapshot } : {}) });
		}),
	);

	server.registerTool(
		"remove_tracks_from_playlist",
		{
			title: "Remove tracks from playlist",
			description: "Remove all occurrences of the given tracks from a playlist.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or URI"),
				uris: z
					.array(z.string())
					.min(1)
					.max(100)
					.describe("Track IDs or spotify:track: URIs to remove (all occurrences)"),
			},
			annotations: destructive,
		},
		guard(async ({ playlist_id, uris }) => {
			const fullUris = uris.map((u) => toUri("track", u));
			const snapshot = await removePlaylistTracks(sp(), playlist_id, fullUris);
			return ok({ removed: fullUris.length, ...(snapshot ? { snapshot_id: snapshot } : {}) });
		}),
	);

	server.registerTool(
		"reorder_playlist",
		{
			title: "Reorder playlist",
			description:
				"Move a track (or a consecutive range) to a different position in a playlist. Use get_playlist first to see current positions.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or URI"),
				range_start: z
					.number()
					.int()
					.min(0)
					.describe("Zero-based position of the first track to move"),
				insert_before: z
					.number()
					.int()
					.min(0)
					.describe(
						"Zero-based position to insert at. 0 moves to the start; playlist length moves to the end.",
					),
				range_length: z
					.number()
					.int()
					.min(1)
					.default(1)
					.describe("Number of consecutive tracks to move"),
			},
			annotations: destructiveOnce,
		},
		guard(async ({ playlist_id, range_start, insert_before, range_length }) => {
			const snapshot = await reorderPlaylistTracks(sp(), playlist_id, {
				rangeStart: range_start,
				insertBefore: insert_before,
				rangeLength: range_length,
			});
			return ok({ reordered: true, ...(snapshot ? { snapshot_id: snapshot } : {}) });
		}),
	);

	server.registerTool(
		"set_playlist_cover",
		{
			title: "Set playlist cover art",
			description:
				"Replace a playlist's cover image. Takes an https URL serving a JPEG of at most 256 KB; PNGs and oversized images are rejected before upload.",
			inputSchema: {
				playlist_id: z.string().describe("Playlist ID or URI"),
				image_url: z.string().describe("https URL of a JPEG image, 256 KB or smaller"),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		guard(async ({ playlist_id, image_url }) => {
			if (!image_url.startsWith("https://")) {
				return toolError("image_url must be an https URL.");
			}
			await setPlaylistCover(sp(), playlist_id, await fetchCoverAsBase64(image_url));
			return okText("Cover art updated. Spotify can take a minute to show it everywhere.");
		}),
	);

	server.registerTool(
		"follow_playlist",
		{
			title: "Follow playlist",
			description: "Follow a playlist, adding it to the user's library.",
			inputSchema: { playlist_id: z.string().describe("Playlist ID or URI") },
			annotations: additiveIdempotent,
		},
		guard(async ({ playlist_id }) => {
			await followPlaylist(sp(), playlist_id);
			return okText("Playlist followed.");
		}),
	);

	server.registerTool(
		"unfollow_playlist",
		{
			title: "Unfollow or delete playlist",
			description:
				"Unfollow (remove from your library) a playlist. For playlists you own this effectively deletes them.",
			inputSchema: { playlist_id: z.string().describe("Playlist ID or URI") },
			annotations: destructive,
		},
		guard(async ({ playlist_id }) => {
			await unfollowPlaylist(sp(), playlist_id);
			return okText("Playlist unfollowed/deleted.");
		}),
	);

	server.registerTool(
		"get_saved_tracks",
		{
			title: "Liked songs",
			description: "List the user's saved (liked) tracks.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0),
			},
			annotations: readOnly,
		},
		guard(async ({ limit, offset }) => {
			const page = await getSavedTracks(sp(), { limit, offset });
			return ok({
				total: page.total,
				offset,
				tracks: page.tracks.map((t, i) => ({
					...compactTrack(t),
					...(page.addedAt[i] ? { added_at: page.addedAt[i] } : {}),
				})),
			});
		}),
	);

	server.registerTool(
		"save_tracks",
		{
			title: "Like tracks",
			description: "Save (like) tracks to the user's library.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Track IDs or spotify:track: URIs"),
			},
			annotations: additiveIdempotent,
		},
		guard(async ({ ids }) => {
			await saveTracks(sp(), ids);
			return okText(`Saved ${ids.length} track(s).`);
		}),
	);

	server.registerTool(
		"remove_saved_tracks",
		{
			title: "Unlike tracks",
			description: "Remove tracks from the user's saved (liked) tracks.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Track IDs or spotify:track: URIs"),
			},
			annotations: destructive,
		},
		guard(async ({ ids }) => {
			await removeSavedTracks(sp(), ids);
			return okText(`Removed ${ids.length} track(s).`);
		}),
	);

	server.registerTool(
		"get_saved_albums",
		{
			title: "Saved albums",
			description: "List the albums saved to the user's library.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0),
			},
			annotations: readOnly,
		},
		guard(async ({ limit, offset }) => {
			const page = await getSavedAlbums(sp(), { limit, offset });
			return ok({
				total: page.total,
				offset,
				albums: page.albums.map((a, i) => ({
					...compactAlbum(a),
					...(page.addedAt[i] ? { added_at: page.addedAt[i] } : {}),
				})),
			});
		}),
	);

	server.registerTool(
		"save_albums",
		{
			title: "Save albums",
			description: "Save albums to the user's library.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Album IDs or spotify:album: URIs"),
			},
			annotations: additiveIdempotent,
		},
		guard(async ({ ids }) => {
			await saveAlbums(sp(), ids);
			return okText(`Saved ${ids.length} album(s).`);
		}),
	);

	server.registerTool(
		"remove_saved_albums",
		{
			title: "Remove saved albums",
			description: "Remove albums from the user's library.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Album IDs or spotify:album: URIs"),
			},
			annotations: destructive,
		},
		guard(async ({ ids }) => {
			await removeSavedAlbums(sp(), ids);
			return okText(`Removed ${ids.length} album(s).`);
		}),
	);

	server.registerTool(
		"get_followed_artists",
		{
			title: "Followed artists",
			description: "List the artists the user follows.",
			inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
			annotations: readOnly,
		},
		guard(async ({ limit }) => {
			const page = await getFollowedArtists(sp(), { limit });
			return ok({ total: page.total, artists: page.items.map(compactArtist) });
		}),
	);

	server.registerTool(
		"follow_artists",
		{
			title: "Follow artists",
			description: "Follow artists on behalf of the user.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Artist IDs or spotify:artist: URIs"),
			},
			annotations: additiveIdempotent,
		},
		guard(async ({ ids }) => {
			await followArtists(sp(), ids);
			return okText(`Followed ${ids.length} artist(s).`);
		}),
	);

	server.registerTool(
		"unfollow_artists",
		{
			title: "Unfollow artists",
			description: "Stop following artists.",
			inputSchema: {
				ids: z
					.array(z.string())
					.min(1)
					.max(LIBRARY_WRITE_MAX)
					.describe("Artist IDs or spotify:artist: URIs"),
			},
			annotations: destructive,
		},
		guard(async ({ ids }) => {
			await unfollowArtists(sp(), ids);
			return okText(`Unfollowed ${ids.length} artist(s).`);
		}),
	);

	server.registerTool(
		"check_library",
		{
			title: "Check library",
			description:
				"Check whether tracks or albums are already saved, or artists already followed, in one call (max 40 IDs, 20 for albums). Use before save_tracks, save_albums or follow_artists instead of paging the library.",
			inputSchema: {
				kind: z.enum(["track", "album", "artist"]),
				ids: z
					.array(z.string())
					.min(1)
					.max(CONTAINS_MAX.track)
					.describe("IDs or spotify: URIs of one kind"),
			},
			annotations: readOnly,
		},
		guard(async ({ kind, ids }) => {
			if (ids.length > CONTAINS_MAX[kind]) {
				return toolError(`check_library takes at most ${CONTAINS_MAX[kind]} ${kind} IDs per call.`);
			}
			const flags = await libraryContains(sp(), kind, ids);
			// Pair by position, so a short answer must fail rather than mislabel.
			if (flags.length !== ids.length) {
				return toolError(`Spotify answered for ${flags.length} of ${ids.length} IDs; try again.`);
			}
			return ok({
				kind,
				items: ids.map((id, i) => ({ id, in_library: flags[i] ?? false })),
			});
		}),
	);

	server.registerTool(
		"get_playback_state",
		{
			title: "Now playing",
			description:
				"Get the current playback state: playing track, device, progress, shuffle/repeat.",
			inputSchema: {},
			annotations: readOnly,
		},
		guard(async () => {
			const state = await getPlaybackState(sp());
			if (!state?.item) {
				return okText("No active playback.");
			}
			return ok({
				is_playing: state.is_playing,
				...(state.progress_ms != null ? { progress_ms: state.progress_ms } : {}),
				...(state.shuffle_state != null ? { shuffle: state.shuffle_state } : {}),
				...(state.repeat_state ? { repeat: state.repeat_state } : {}),
				...(state.device
					? {
							device: {
								name: state.device.name,
								...(state.device.id ? { id: state.device.id } : {}),
								...(state.device.volume_percent != null
									? { volume_percent: state.device.volume_percent }
									: {}),
							},
						}
					: {}),
				track: compactTrack(state.item),
				...(state.context?.uri ? { context: state.context.uri } : {}),
			});
		}),
	);

	server.registerTool(
		"control_playback",
		{
			title: "Control playback",
			description:
				"Control playback: play (optionally a context or tracks), pause, next, previous, seek, volume, shuffle, repeat. Requires an active Spotify device and Premium.",
			inputSchema: {
				action: z.enum([
					"play",
					"pause",
					"next",
					"previous",
					"seek",
					"volume",
					"shuffle",
					"repeat",
				]),
				context_uri: z
					.string()
					.optional()
					.describe("Context URI to play (album/playlist/artist), only with action=play"),
				uris: z
					.array(z.string())
					.optional()
					.describe("Track URIs to play, only with action=play (ignored if context_uri set)"),
				position_ms: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Position in ms, required for action=seek"),
				volume_percent: z
					.number()
					.int()
					.min(0)
					.max(100)
					.optional()
					.describe("Volume 0-100, required for action=volume"),
				state: z
					.enum(["on", "off", "track", "context"])
					.optional()
					.describe("For shuffle: on/off. For repeat: track/context/off."),
				device_id: z
					.string()
					.optional()
					.describe("Target device ID (default: the currently active device)"),
			},
			annotations: additive,
		},
		guard(async ({ action, context_uri, uris, position_ms, volume_percent, state, device_id }) => {
			switch (action) {
				case "play":
					await controlPlayback(
						sp(),
						{
							action,
							...(uris ? { uris } : {}),
							...(context_uri ? { contextUri: context_uri } : {}),
						},
						device_id,
					);
					break;
				case "pause":
				case "next":
				case "previous":
					await controlPlayback(sp(), { action }, device_id);
					break;
				case "seek":
					if (position_ms === undefined) return toolError("action=seek requires position_ms.");
					await controlPlayback(sp(), { action, positionMs: position_ms }, device_id);
					break;
				case "volume":
					if (volume_percent === undefined) {
						return toolError("action=volume requires volume_percent.");
					}
					await controlPlayback(sp(), { action, volumePercent: volume_percent }, device_id);
					break;
				case "shuffle":
					if (state !== "on" && state !== "off") {
						return toolError("action=shuffle requires state=on or state=off.");
					}
					await controlPlayback(sp(), { action, state: state === "on" }, device_id);
					break;
				case "repeat":
					if (state !== "track" && state !== "context" && state !== "off") {
						return toolError("action=repeat requires state=track, context or off.");
					}
					await controlPlayback(sp(), { action, state }, device_id);
					break;
			}
			return okText(`Playback action '${action}' done.`);
		}),
	);

	server.registerTool(
		"get_queue",
		{
			title: "Playback queue",
			description: "Get the current playback queue: now playing plus upcoming tracks.",
			inputSchema: {},
			annotations: readOnly,
		},
		guard(async () => {
			const q = await getQueue(sp());
			return ok({
				...(q.currently_playing ? { currently_playing: compactTrack(q.currently_playing) } : {}),
				queue: (q.queue ?? []).slice(0, 20).map(compactTrack),
			});
		}),
	);

	server.registerTool(
		"add_to_queue",
		{
			title: "Queue a track",
			description: "Add a track to the playback queue.",
			inputSchema: {
				uri: z.string().describe("Track ID or spotify:track: URI"),
				device_id: z.string().optional().describe("Target device ID"),
			},
			annotations: additive,
		},
		guard(async ({ uri, device_id }) => {
			await addToQueue(sp(), uri, device_id);
			return okText("Added to queue.");
		}),
	);

	server.registerTool(
		"list_devices",
		{
			title: "Available devices",
			description: "List the user's available Spotify devices.",
			inputSchema: {},
			annotations: readOnly,
		},
		guard(async () => {
			const devices = await getDevices(sp());
			return ok({
				devices: devices.map((d) => ({
					...(d.id ? { id: d.id } : {}),
					name: d.name,
					...(d.type ? { type: d.type } : {}),
					is_active: d.is_active,
					...(d.volume_percent != null ? { volume_percent: d.volume_percent } : {}),
				})),
			});
		}),
	);

	server.registerTool(
		"transfer_playback",
		{
			title: "Switch device",
			description: "Transfer playback to a different device (see list_devices).",
			inputSchema: {
				device_id: z.string().describe("Target device ID"),
				play: z.boolean().default(true).describe("Start playing after transfer"),
			},
			annotations: additiveIdempotent,
		},
		guard(async ({ device_id, play }) => {
			await transferPlayback(sp(), device_id, play);
			return okText("Playback transferred.");
		}),
	);

	server.registerTool(
		"get_recently_played",
		{
			title: "Recently played",
			description: "List recently played tracks, most recent first.",
			inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
			annotations: readOnly,
		},
		guard(async ({ limit }) => {
			const res = await getRecentlyPlayed(sp(), { limit });
			return ok({
				tracks: res.items.map((entry) => ({
					...compactTrack(entry.track),
					played_at: entry.played_at,
					...(entry.context?.uri ? { context: entry.context.uri } : {}),
				})),
			});
		}),
	);

	server.registerTool(
		"get_top_items",
		{
			title: "Top artists and tracks",
			description:
				"Get the user's top artists or tracks over a time range - the measured foundation for taste profiling and recommendations.",
			inputSchema: {
				type: z.enum(["artists", "tracks"]),
				time_range: z
					.enum(["short_term", "medium_term", "long_term"])
					.default("medium_term")
					.describe("short_term ~4 weeks, medium_term ~6 months, long_term ~years"),
				limit: z.number().int().min(1).max(50).default(20),
			},
			annotations: readOnly,
		},
		guard(async ({ type, time_range, limit }) => {
			if (type === "artists") {
				const page = await getTopArtists(sp(), { timeRange: time_range, limit });
				return ok({ artists: page.items.map(compactArtist) });
			}
			const page = await getTopTracks(sp(), { timeRange: time_range, limit });
			return ok({ tracks: page.items.map(compactTrack) });
		}),
	);

	// Prompts carry the workflows that aren't obvious from the tool list —
	// mostly ways to rebuild what Spotify withdrew from third-party apps.
	server.registerPrompt(
		"discover_similar",
		{
			title: "Find similar artists",
			description:
				"Suggest artists similar to one you name, and offer to queue or save what looks good.",
			argsSchema: { artist: z.string().describe("Artist to find neighbours for") },
		},
		({ artist }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Find artists similar to ${artist}.

Spotify's related-artists and /recommendations endpoints are gone for third-party apps, so work it out: get_artist for their genres, search_music with genre: and year: filters, and get_top_items to bias toward what I already listen to. Skip anything already in my top artists.

Give me 8-10 artists with one line each on why, plus a representative track. Then ask whether to save them or build a playlist.`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"taste_profile",
		{
			title: "Profile my listening",
			description: "Summarise listening habits from top items and recent plays.",
			argsSchema: {
				time_range: z
					.string()
					.optional()
					.describe("short_term (~4 weeks), medium_term (~6 months) or long_term"),
			},
		},
		({ time_range }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Profile my listening over ${time_range ?? "medium_term"}.

Use get_top_items for both artists and tracks, plus get_recently_played. Tell me the genres and moods that dominate, what has changed lately versus the longer ranges, and two or three blind spots worth exploring. Be specific and skip the flattery.`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"build_playlist",
		{
			title: "Build a playlist",
			description: "Assemble and create a playlist from a described vibe.",
			argsSchema: {
				vibe: z.string().describe("What the playlist is for, e.g. 'rainy sunday morning'"),
				size: z.string().optional().describe("Number of tracks (default 20)"),
			},
		},
		({ vibe, size }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Build me a playlist for: ${vibe}. Around ${size ?? "20"} tracks.

Draw on get_top_items and get_recently_played so it sounds like me, then search_music to fill the gaps. Show the tracklist and wait for my go-ahead before create_playlist and add_tracks_to_playlist. Create it private unless I say otherwise.`,
					},
				},
			],
		}),
	);
}
