// Typed endpoint functions for verified-alive Spotify endpoints, with
// restricted-vs-legacy regime fallback where the Feb 2026 migration moved
// things. Dead endpoints (recommendations, audio-features, audio-analysis,
// batch /tracks?ids=) are deliberately not exposed.

import { z } from "zod";
import { type SpotifyClient, toId, toUri } from "./spotify";
import {
	type Album,
	type Artist,
	albumSchema,
	artistSchema,
	type CurrentUser,
	currentUserSchema,
	type Device,
	devicesResponseSchema,
	type PlaybackState,
	type Playlist,
	pagingSchema,
	playbackStateSchema,
	playlistEntrySchema,
	playlistSchema,
	queueSchema,
	recentlyPlayedSchema,
	type SimplifiedAlbum,
	savedTrackSchema,
	searchResponseSchema,
	snapshotSchema,
	type Track,
	trackSchema,
} from "./types";

/** Restricted-regime search caps page size at 10; works in both regimes. */
export const SEARCH_PER_REQUEST_CAP = 10;

export type SearchType = "track" | "artist" | "album" | "playlist";

export function getMe(client: SpotifyClient): Promise<CurrentUser> {
	return client.request("/me", currentUserSchema);
}

async function searchOne<T>(
	client: SpotifyClient,
	query: string,
	type: SearchType,
	limit: number,
	pick: (page: z.infer<typeof searchResponseSchema>) => { items: (T | null)[]; next?: unknown },
): Promise<T[]> {
	const items = await client.paginate<T | null>(
		async (pageLimit, offset) => {
			const page = await client.request("/search", searchResponseSchema, {
				query: { q: query, type, limit: pageLimit, offset },
			});
			const bucket = pick(page);
			return { items: bucket.items, hasNext: bucket.next != null };
		},
		{ total: limit, perRequest: SEARCH_PER_REQUEST_CAP },
	);
	return items.filter((x): x is T => x !== null);
}

export interface SearchResults {
	tracks?: Track[];
	artists?: Artist[];
	albums?: z.infer<typeof albumSchema>[];
	playlists?: Playlist[];
}

/** Fans out one paginated search per requested type so offsets stay coherent. */
export async function search(
	client: SpotifyClient,
	query: string,
	types: SearchType[],
	limit: number,
): Promise<SearchResults> {
	const out: SearchResults = {};
	for (const type of types) {
		switch (type) {
			case "track":
				out.tracks = await searchOne(client, query, type, limit, (p) => ({
					items: p.tracks?.items ?? [],
					next: p.tracks?.next,
				}));
				break;
			case "artist":
				out.artists = await searchOne(client, query, type, limit, (p) => ({
					items: p.artists?.items ?? [],
					next: p.artists?.next,
				}));
				break;
			case "album":
				out.albums = await searchOne(client, query, type, limit, (p) => ({
					items: p.albums?.items ?? [],
					next: p.albums?.next,
				}));
				break;
			case "playlist":
				out.playlists = await searchOne(client, query, type, limit, (p) => ({
					items: p.playlists?.items ?? [],
					next: p.playlists?.next,
				}));
				break;
		}
	}
	return out;
}

export function getTrack(client: SpotifyClient, id: string): Promise<Track> {
	return client.request(`/tracks/${encodeURIComponent(toId(id))}`, trackSchema);
}

export function getArtist(client: SpotifyClient, id: string): Promise<Artist> {
	return client.request(`/artists/${encodeURIComponent(toId(id))}`, artistSchema);
}

export function getAlbum(client: SpotifyClient, id: string): Promise<Album> {
	return client.request(`/albums/${encodeURIComponent(toId(id))}`, albumSchema);
}

export async function getMyPlaylists(
	client: SpotifyClient,
	options: { limit?: number; offset?: number } = {},
): Promise<{ items: Playlist[]; total: number | null }> {
	const page = await client.request("/me/playlists", pagingSchema(playlistSchema.nullable()), {
		query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
	});
	return {
		items: page.items.filter((p): p is Playlist => p !== null),
		total: page.total ?? null,
	};
}

export function getPlaylist(client: SpotifyClient, id: string): Promise<Playlist> {
	return client.request(`/playlists/${encodeURIComponent(toId(id))}`, playlistSchema);
}

/** Restricted renamed `/tracks` to `/items` and `track` to `item`. */
export async function getPlaylistTracks(
	client: SpotifyClient,
	id: string,
	options: { limit?: number; offset?: number } = {},
): Promise<{ tracks: Track[]; addedAt: (string | null)[]; total: number | null }> {
	const pid = encodeURIComponent(toId(id));
	const query = { limit: options.limit ?? 50, offset: options.offset ?? 0 };
	const schema = pagingSchema(playlistEntrySchema);
	const page = await client.withFallback(
		"playlist-items",
		() => client.request(`/playlists/${pid}/items`, schema, { query }),
		() => client.request(`/playlists/${pid}/tracks`, schema, { query }),
	);
	const tracks: Track[] = [];
	const addedAt: (string | null)[] = [];
	for (const entry of page.items) {
		const track = entry.item ?? entry.track;
		if (track) {
			tracks.push(track);
			addedAt.push(entry.added_at ?? null);
		}
	}
	return { tracks, addedAt, total: page.total ?? null };
}

/** Restricted moved playlist creation from /users/{id}/playlists to /me/playlists. */
export function createPlaylist(
	client: SpotifyClient,
	options: { name: string; description?: string; isPublic?: boolean; collaborative?: boolean },
): Promise<Playlist> {
	const body = {
		name: options.name,
		...(options.description !== undefined ? { description: options.description } : {}),
		public: options.isPublic ?? false,
		...(options.collaborative !== undefined ? { collaborative: options.collaborative } : {}),
	};
	return client.withFallback(
		"create-playlist",
		() => client.request("/me/playlists", playlistSchema, { method: "POST", body }),
		async () => {
			const me = await getMe(client);
			return client.request(`/users/${encodeURIComponent(me.id)}/playlists`, playlistSchema, {
				method: "POST",
				body,
			});
		},
	);
}

export function updatePlaylistDetails(
	client: SpotifyClient,
	id: string,
	details: { name?: string; description?: string; isPublic?: boolean },
): Promise<void> {
	const body = {
		...(details.name !== undefined ? { name: details.name } : {}),
		...(details.description !== undefined ? { description: details.description } : {}),
		...(details.isPublic !== undefined ? { public: details.isPublic } : {}),
	};
	return client.requestVoid(`/playlists/${encodeURIComponent(toId(id))}`, {
		method: "PUT",
		body,
	});
}

export async function addPlaylistTracks(
	client: SpotifyClient,
	playlistId: string,
	uris: string[],
	position?: number,
): Promise<string | null> {
	const pid = encodeURIComponent(toId(playlistId));
	const body = { uris, ...(position !== undefined ? { position } : {}) };
	const res = await client.withFallback(
		"playlist-items",
		() => client.request(`/playlists/${pid}/items`, snapshotSchema, { method: "POST", body }),
		() => client.request(`/playlists/${pid}/tracks`, snapshotSchema, { method: "POST", body }),
	);
	return res.snapshot_id ?? null;
}

/** Restricted DELETE body keys off `items`; legacy off `tracks`. */
export async function removePlaylistTracks(
	client: SpotifyClient,
	playlistId: string,
	uris: string[],
): Promise<string | null> {
	const pid = encodeURIComponent(toId(playlistId));
	const entries = uris.map((uri) => ({ uri }));
	const res = await client.withFallback(
		"playlist-items",
		() =>
			client.request(`/playlists/${pid}/items`, snapshotSchema, {
				method: "DELETE",
				body: { items: entries },
			}),
		() =>
			client.request(`/playlists/${pid}/tracks`, snapshotSchema, {
				method: "DELETE",
				body: { tracks: entries },
			}),
	);
	return res.snapshot_id ?? null;
}

export async function reorderPlaylistTracks(
	client: SpotifyClient,
	playlistId: string,
	options: { rangeStart: number; insertBefore: number; rangeLength?: number },
): Promise<string | null> {
	const pid = encodeURIComponent(toId(playlistId));
	const body = {
		range_start: options.rangeStart,
		insert_before: options.insertBefore,
		range_length: options.rangeLength ?? 1,
	};
	const res = await client.withFallback(
		"playlist-items",
		() => client.request(`/playlists/${pid}/items`, snapshotSchema, { method: "PUT", body }),
		() => client.request(`/playlists/${pid}/tracks`, snapshotSchema, { method: "PUT", body }),
	);
	return res.snapshot_id ?? null;
}

export function unfollowPlaylist(client: SpotifyClient, id: string): Promise<void> {
	return client.requestVoid(`/playlists/${encodeURIComponent(toId(id))}/followers`, {
		method: "DELETE",
	});
}

export async function getSavedTracks(
	client: SpotifyClient,
	options: { limit?: number; offset?: number } = {},
): Promise<{ tracks: Track[]; addedAt: (string | null)[]; total: number | null }> {
	const page = await client.request("/me/tracks", pagingSchema(savedTrackSchema), {
		query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
	});
	const tracks: Track[] = [];
	const addedAt: (string | null)[] = [];
	for (const entry of page.items) {
		const track = entry.item ?? entry.track;
		if (track) {
			tracks.push(track);
			addedAt.push(entry.added_at ?? null);
		}
	}
	return { tracks, addedAt, total: page.total ?? null };
}

/** Restricted consolidated library writes onto /me/library with `uris`. */
export function saveTracks(client: SpotifyClient, trackIds: string[]): Promise<void> {
	const ids = trackIds.map(toId);
	return client.withFallback(
		"library-write",
		() =>
			client.requestVoid("/me/library", {
				method: "PUT",
				body: { uris: ids.map((id) => toUri("track", id)) },
			}),
		() => client.requestVoid("/me/tracks", { method: "PUT", body: { ids } }),
	);
}

export function removeSavedTracks(client: SpotifyClient, trackIds: string[]): Promise<void> {
	const ids = trackIds.map(toId);
	return client.withFallback(
		"library-write",
		() =>
			client.requestVoid("/me/library", {
				method: "DELETE",
				body: { uris: ids.map((id) => toUri("track", id)) },
			}),
		() => client.requestVoid("/me/tracks", { method: "DELETE", body: { ids } }),
	);
}

const containsSchema = z.array(z.boolean());

export function savedTracksContain(client: SpotifyClient, trackIds: string[]): Promise<boolean[]> {
	const ids = trackIds.map(toId);
	return client.withFallback(
		"library-contains",
		() =>
			client.request("/me/library/contains", containsSchema, {
				query: { uris: ids.map((id) => toUri("track", id)).join(",") },
			}),
		() =>
			client.request("/me/tracks/contains", containsSchema, {
				query: { ids: ids.join(",") },
			}),
	);
}

export function getPlaybackState(client: SpotifyClient): Promise<PlaybackState | undefined> {
	// Spotify returns 204 with no body when nothing is playing.
	return client.request("/me/player", playbackStateSchema.optional());
}

export async function getDevices(client: SpotifyClient): Promise<Device[]> {
	const res = await client.request("/me/player/devices", devicesResponseSchema);
	return res.devices;
}

export function getQueue(client: SpotifyClient): Promise<z.infer<typeof queueSchema>> {
	return client.request("/me/player/queue", queueSchema);
}

export function getRecentlyPlayed(
	client: SpotifyClient,
	options: { limit?: number } = {},
): Promise<z.infer<typeof recentlyPlayedSchema>> {
	return client.request("/me/player/recently-played", recentlyPlayedSchema, {
		query: { limit: options.limit ?? 20 },
	});
}

export type TopItemsType = "artists" | "tracks";
export type TimeRange = "short_term" | "medium_term" | "long_term";

export function getTopArtists(
	client: SpotifyClient,
	options: { timeRange?: TimeRange; limit?: number } = {},
): Promise<{ items: Artist[] }> {
	return client.request("/me/top/artists", pagingSchema(artistSchema), {
		query: { time_range: options.timeRange ?? "medium_term", limit: options.limit ?? 20 },
	});
}

export function getTopTracks(
	client: SpotifyClient,
	options: { timeRange?: TimeRange; limit?: number } = {},
): Promise<{ items: Track[] }> {
	return client.request("/me/top/tracks", pagingSchema(trackSchema), {
		query: { time_range: options.timeRange ?? "medium_term", limit: options.limit ?? 20 },
	});
}

export type PlaybackCommand =
	| { action: "play"; uris?: string[]; contextUri?: string }
	| { action: "pause" }
	| { action: "next" }
	| { action: "previous" }
	| { action: "seek"; positionMs: number }
	| { action: "volume"; volumePercent: number }
	| { action: "shuffle"; state: boolean }
	| { action: "repeat"; state: "track" | "context" | "off" };

export async function controlPlayback(
	client: SpotifyClient,
	command: PlaybackCommand,
	deviceId?: string,
): Promise<void> {
	const device = deviceId !== undefined ? { device_id: deviceId } : {};
	switch (command.action) {
		case "play": {
			const body = {
				...(command.uris?.length ? { uris: command.uris.map((u) => toUri("track", u)) } : {}),
				...(command.contextUri ? { context_uri: command.contextUri } : {}),
			};
			await client.requestVoid("/me/player/play", {
				method: "PUT",
				query: device,
				...(Object.keys(body).length > 0 ? { body } : {}),
			});
			return;
		}
		case "pause":
			await client.requestVoid("/me/player/pause", { method: "PUT", query: device });
			return;
		case "next":
			await client.requestVoid("/me/player/next", { method: "POST", query: device });
			return;
		case "previous":
			await client.requestVoid("/me/player/previous", { method: "POST", query: device });
			return;
		case "seek":
			await client.requestVoid("/me/player/seek", {
				method: "PUT",
				query: { position_ms: command.positionMs, ...device },
			});
			return;
		case "volume":
			await client.requestVoid("/me/player/volume", {
				method: "PUT",
				query: { volume_percent: command.volumePercent, ...device },
			});
			return;
		case "shuffle":
			await client.requestVoid("/me/player/shuffle", {
				method: "PUT",
				query: { state: command.state, ...device },
			});
			return;
		case "repeat":
			await client.requestVoid("/me/player/repeat", {
				method: "PUT",
				query: { state: command.state, ...device },
			});
			return;
	}
}

export function addToQueue(client: SpotifyClient, uri: string, deviceId?: string): Promise<void> {
	return client.requestVoid("/me/player/queue", {
		method: "POST",
		query: {
			uri: toUri("track", uri),
			...(deviceId !== undefined ? { device_id: deviceId } : {}),
		},
	});
}

export function transferPlayback(
	client: SpotifyClient,
	deviceId: string,
	play: boolean,
): Promise<void> {
	return client.requestVoid("/me/player", {
		method: "PUT",
		body: { device_ids: [deviceId], play },
	});
}

// --- Compact output mappers: keep tool results small for the model ---

export function compactTrack(track: Track): Record<string, unknown> {
	return {
		...(track.id ? { id: track.id } : {}),
		name: track.name,
		artist: track.artists?.map((a) => a.name).join(", ") ?? "unknown",
		...(track.album?.name ? { album: track.album.name } : {}),
		...(track.album?.release_date ? { released: track.album.release_date } : {}),
		...(track.duration_ms != null ? { duration_ms: track.duration_ms } : {}),
	};
}

export function compactPlaylist(p: Playlist): Record<string, unknown> {
	return {
		id: p.id,
		name: p.name,
		...(p.description ? { description: p.description } : {}),
		...(p.public != null ? { public: p.public } : {}),
		owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
		track_count: p.items?.total ?? p.tracks?.total ?? null,
		...(p.snapshot_id ? { snapshot_id: p.snapshot_id } : {}),
	};
}

export function compactArtist(a: Artist): Record<string, unknown> {
	return {
		id: a.id,
		name: a.name,
		...(a.genres?.length ? { genres: a.genres } : {}),
		...(a.followers?.total != null ? { followers: a.followers.total } : {}),
		...(a.popularity != null ? { popularity: a.popularity } : {}),
	};
}

export function compactAlbum(a: SimplifiedAlbum): Record<string, unknown> {
	return {
		id: a.id,
		name: a.name,
		artist: a.artists?.map((x) => x.name).join(", ") ?? "unknown",
		...(a.release_date ? { released: a.release_date } : {}),
		...(a.total_tracks != null ? { total_tracks: a.total_tracks } : {}),
	};
}
