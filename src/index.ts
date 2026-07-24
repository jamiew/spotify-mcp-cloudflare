import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	addPlaylistTracks,
	addToQueue,
	compactAlbum,
	compactArtist,
	compactPlaylist,
	compactTrack,
	controlPlayback,
	createPlaylist,
	getAlbum,
	getArtist,
	getDevices,
	getMe,
	getMyPlaylists,
	getPlaybackState,
	getPlaylist,
	getPlaylistTracks,
	getQueue,
	getRecentlyPlayed,
	getSavedTracks,
	getTopArtists,
	getTopTracks,
	getTrack,
	removePlaylistTracks,
	removeSavedTracks,
	reorderPlaylistTracks,
	type SearchType,
	saveTracks,
	search,
	transferPlayback,
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
	SpotifyClient,
} from "./spotify";
import { SpotifyHandler } from "./spotify-handler";
import { isEmailAllowed, type Props, refreshSpotifyToken } from "./utils";

/** Working token state, persisted in the Durable Object. */
type State = {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
};

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
		if (e.status === 403) {
			return toolError("Spotify refused this action (forbidden). The account may lack access.");
		}
		return toolError(`The request to Spotify failed (HTTP ${e.status}). Try again shortly.`);
	}
	return toolError(e instanceof Error ? e.message : String(e));
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

export class SpotifyMCP extends McpAgent<Env, State, Props> {
	server = new McpServer({
		name: "spotify-mcp",
		version: "0.3.0",
	});

	initialState: State = { accessToken: "", refreshToken: "", expiresAt: 0 };

	private client!: SpotifyClient;
	/** Dedups concurrent refreshes so parallel tool calls share one request. */
	private refreshInFlight: Promise<string> | null = null;

	private async doRefresh(): Promise<string> {
		if (!this.refreshInFlight) {
			this.refreshInFlight = (async () => {
				try {
					const t = await refreshSpotifyToken({
						clientId: this.env.SPOTIFY_CLIENT_ID,
						clientSecret: this.env.SPOTIFY_CLIENT_SECRET,
						refreshToken: this.state.refreshToken,
					});
					this.setState({
						accessToken: t.accessToken,
						refreshToken: t.refreshToken ?? this.state.refreshToken,
						expiresAt: t.expiresAt,
					});
					return t.accessToken;
				} catch (e) {
					// A rejected refresh grant means the user revoked access.
					if (e instanceof Error && e.message.includes("invalid_grant")) {
						throw new SpotifyAuthError();
					}
					throw e;
				} finally {
					this.refreshInFlight = null;
				}
			})();
		}
		return this.refreshInFlight;
	}

	async init() {
		// Backup access gate (primary check is at the OAuth callback). If this
		// grant's email isn't allowed, register no tools.
		if (!isEmailAllowed(this.props?.email, this.env.ALLOWED_EMAILS)) {
			return;
		}

		// Seed the persisted token state from the OAuth props on first run.
		if (!this.state.accessToken && this.props?.accessToken) {
			this.setState({
				accessToken: this.props.accessToken,
				refreshToken: this.props.refreshToken,
				expiresAt: this.props.expiresAt,
			});
		}

		this.client = new SpotifyClient({
			tokenProvider: {
				getAccessToken: async () => {
					if (Date.now() + 60_000 >= this.state.expiresAt) {
						return this.doRefresh();
					}
					return this.state.accessToken;
				},
				refreshAccessToken: () => this.doRefresh(),
			},
		});
		const sp = () => this.client;

		this.server.registerTool(
			"get_me",
			{
				description:
					"Get the current user's Spotify profile. Some fields (email, country, product) are unavailable for newer Spotify apps.",
				inputSchema: {},
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

		this.server.registerTool(
			"search_music",
			{
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

		this.server.registerTool(
			"get_track_details",
			{
				description: "Get details for one or more tracks by ID (max 20).",
				inputSchema: {
					ids: z.array(z.string()).min(1).max(20).describe("Track IDs or spotify:track: URIs"),
				},
			},
			guard(async ({ ids }) => {
				const tracks = [];
				for (const id of ids) {
					tracks.push(await getTrack(sp(), id));
				}
				return ok({
					tracks: tracks.map((t) => ({
						...compactTrack(t),
						...(t.explicit != null ? { explicit: t.explicit } : {}),
						...(t.track_number != null ? { track_number: t.track_number } : {}),
						...(t.album?.id ? { album_id: t.album.id } : {}),
						...(t.artists?.length
							? { artist_ids: t.artists.map((a) => a.id).filter(Boolean) }
							: {}),
					})),
				});
			}),
		);

		this.server.registerTool(
			"get_artist_details",
			{
				description:
					"Get details for an artist: name, genres, followers, popularity. (Spotify removed artist top-tracks for third-party apps; use search_music with an artist: filter to find their tracks.)",
				inputSchema: { id: z.string().describe("Artist ID or spotify:artist: URI") },
			},
			guard(async ({ id }) => ok(compactArtist(await getArtist(sp(), id)))),
		);

		this.server.registerTool(
			"get_album_details",
			{
				description: "Get details for an album, including its track list.",
				inputSchema: { id: z.string().describe("Album ID or spotify:album: URI") },
			},
			guard(async ({ id }) => {
				const album = await getAlbum(sp(), id);
				return ok({
					...compactAlbum(album),
					...(album.album_type ? { album_type: album.album_type } : {}),
					tracks: (album.tracks?.items ?? []).map((t) => ({
						...compactTrack(t),
						...(t.track_number != null ? { track_number: t.track_number } : {}),
					})),
				});
			}),
		);

		this.server.registerTool(
			"list_playlists",
			{
				description: "List the current user's playlists: name, id, track count, owner.",
				inputSchema: {
					limit: z.number().int().min(1).max(50).default(20),
					offset: z.number().int().min(0).default(0),
				},
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

		this.server.registerTool(
			"get_playlist",
			{
				description:
					"Get a playlist's details and a page of its tracks, with zero-based positions (needed for reordering/removal). Spotify only returns contents for playlists the user owns, collaborates on, or follows.",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or spotify:playlist: URI"),
					limit: z.number().int().min(1).max(50).default(50),
					offset: z.number().int().min(0).default(0).describe("Index of the first track"),
				},
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

		this.server.registerTool(
			"create_playlist",
			{
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

		this.server.registerTool(
			"update_playlist_details",
			{
				description: "Update a playlist's name, description or public state.",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					name: z.string().optional().describe("New name"),
					description: z.string().optional().describe("New description"),
					public: z.boolean().optional().describe("New public state"),
				},
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

		this.server.registerTool(
			"add_tracks_to_playlist",
			{
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
			},
			guard(async ({ playlist_id, uris, position }) => {
				const fullUris = uris.map((u) => (u.includes(":") ? u : `spotify:track:${u}`));
				const snapshot = await addPlaylistTracks(sp(), playlist_id, fullUris, position);
				return ok({ added: fullUris.length, ...(snapshot ? { snapshot_id: snapshot } : {}) });
			}),
		);

		this.server.registerTool(
			"remove_tracks_from_playlist",
			{
				description: "Remove all occurrences of the given tracks from a playlist.",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					uris: z
						.array(z.string())
						.min(1)
						.max(100)
						.describe("Track IDs or spotify:track: URIs to remove (all occurrences)"),
				},
			},
			guard(async ({ playlist_id, uris }) => {
				const fullUris = uris.map((u) => (u.includes(":") ? u : `spotify:track:${u}`));
				const snapshot = await removePlaylistTracks(sp(), playlist_id, fullUris);
				return ok({ removed: fullUris.length, ...(snapshot ? { snapshot_id: snapshot } : {}) });
			}),
		);

		this.server.registerTool(
			"reorder_playlist",
			{
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

		this.server.registerTool(
			"unfollow_playlist",
			{
				description:
					"Unfollow (remove from your library) a playlist. For playlists you own this effectively deletes them.",
				inputSchema: { playlist_id: z.string().describe("Playlist ID or URI") },
			},
			guard(async ({ playlist_id }) => {
				await unfollowPlaylist(sp(), playlist_id);
				return okText("Playlist unfollowed/deleted.");
			}),
		);

		this.server.registerTool(
			"get_saved_tracks",
			{
				description: "List the user's saved (liked) tracks.",
				inputSchema: {
					limit: z.number().int().min(1).max(50).default(20),
					offset: z.number().int().min(0).default(0),
				},
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

		this.server.registerTool(
			"save_tracks",
			{
				description: "Save (like) tracks to the user's library.",
				inputSchema: {
					ids: z.array(z.string()).min(1).max(50).describe("Track IDs or spotify:track: URIs"),
				},
			},
			guard(async ({ ids }) => {
				await saveTracks(sp(), ids);
				return okText(`Saved ${ids.length} track(s).`);
			}),
		);

		this.server.registerTool(
			"remove_saved_tracks",
			{
				description: "Remove tracks from the user's saved (liked) tracks.",
				inputSchema: {
					ids: z.array(z.string()).min(1).max(50).describe("Track IDs or spotify:track: URIs"),
				},
			},
			guard(async ({ ids }) => {
				await removeSavedTracks(sp(), ids);
				return okText(`Removed ${ids.length} track(s).`);
			}),
		);

		this.server.registerTool(
			"get_playback_state",
			{
				description:
					"Get the current playback state: playing track, device, progress, shuffle/repeat.",
				inputSchema: {},
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

		this.server.registerTool(
			"control_playback",
			{
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
			},
			guard(
				async ({ action, context_uri, uris, position_ms, volume_percent, state, device_id }) => {
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
				},
			),
		);

		this.server.registerTool(
			"get_queue",
			{
				description: "Get the current playback queue: now playing plus upcoming tracks.",
				inputSchema: {},
			},
			guard(async () => {
				const q = await getQueue(sp());
				return ok({
					...(q.currently_playing ? { currently_playing: compactTrack(q.currently_playing) } : {}),
					queue: (q.queue ?? []).slice(0, 20).map(compactTrack),
				});
			}),
		);

		this.server.registerTool(
			"add_to_queue",
			{
				description: "Add a track to the playback queue.",
				inputSchema: {
					uri: z.string().describe("Track ID or spotify:track: URI"),
					device_id: z.string().optional().describe("Target device ID"),
				},
			},
			guard(async ({ uri, device_id }) => {
				await addToQueue(sp(), uri, device_id);
				return okText("Added to queue.");
			}),
		);

		this.server.registerTool(
			"list_devices",
			{
				description: "List the user's available Spotify devices.",
				inputSchema: {},
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

		this.server.registerTool(
			"transfer_playback",
			{
				description: "Transfer playback to a different device (see list_devices).",
				inputSchema: {
					device_id: z.string().describe("Target device ID"),
					play: z.boolean().default(true).describe("Start playing after transfer"),
				},
			},
			guard(async ({ device_id, play }) => {
				await transferPlayback(sp(), device_id, play);
				return okText("Playback transferred.");
			}),
		);

		this.server.registerTool(
			"get_recently_played",
			{
				description: "List recently played tracks, most recent first.",
				inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
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

		this.server.registerTool(
			"get_top_items",
			{
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
	}
}

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": SpotifyMCP.serve("/mcp"),
		"/sse": SpotifyMCP.serveSSE("/sse"),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	// biome-ignore lint/suspicious/noExplicitAny: OAuthProvider's handler type predates Hono's ExportedHandler shape
	defaultHandler: SpotifyHandler as any,
});
