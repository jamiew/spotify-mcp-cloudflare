import { z } from "zod";

// Zod schemas for Spotify responses. Tolerant of both API regimes: the legacy
// shapes (pre-2026 apps) and the restricted Feb-2026 shapes (`tracks`→`items`
// renames, removed fields). Anything Spotify has removed or might remove is
// optional/nullable.

export const simplifiedArtistSchema = z.object({
	id: z.string().nullish(),
	name: z.string(),
	uri: z.string().nullish(),
});

export const imageSchema = z.object({
	url: z.string(),
	height: z.number().nullish(),
	width: z.number().nullish(),
});

export const artistSchema = z.object({
	id: z.string(),
	name: z.string(),
	uri: z.string().nullish(),
	genres: z.array(z.string()).nullish(),
	followers: z.object({ total: z.number().nullish() }).nullish(),
	popularity: z.number().nullish(),
});

export const simplifiedAlbumSchema = z.object({
	id: z.string(),
	name: z.string(),
	uri: z.string().nullish(),
	album_type: z.string().nullish(),
	release_date: z.string().nullish(),
	total_tracks: z.number().nullish(),
	artists: z.array(simplifiedArtistSchema).nullish(),
});

export const trackSchema = z.object({
	id: z.string().nullish(),
	name: z.string(),
	uri: z.string().nullish(),
	duration_ms: z.number().nullish(),
	explicit: z.boolean().nullish(),
	track_number: z.number().nullish(),
	artists: z.array(simplifiedArtistSchema).nullish(),
	album: simplifiedAlbumSchema.nullish(),
	is_local: z.boolean().nullish(),
});

export const albumSchema = simplifiedAlbumSchema.extend({
	tracks: z
		.object({
			items: z.array(trackSchema).nullish(),
			total: z.number().nullish(),
		})
		.nullish(),
});

// Legacy /me returns display_name/email/country/product; restricted returns
// little more than id. The email allowlist only works when Spotify still
// returns email.
export const currentUserSchema = z.object({
	id: z.string(),
	display_name: z.string().nullish(),
	email: z.string().nullish(),
	country: z.string().nullish(),
	product: z.string().nullish(),
	uri: z.string().nullish(),
});

export function pagingSchema<T extends z.ZodType>(item: T) {
	return z.object({
		items: z.array(item),
		total: z.number().nullish(),
		limit: z.number().nullish(),
		offset: z.number().nullish(),
		next: z.string().nullish(),
	});
}

// Playlist as it appears in list/detail responses. Restricted renamed the
// `tracks` count field to `items`; tolerate both.
export const playlistSchema = z.object({
	id: z.string(),
	name: z.string(),
	uri: z.string().nullish(),
	description: z.string().nullish(),
	public: z.boolean().nullish(),
	collaborative: z.boolean().nullish(),
	owner: z.object({ id: z.string().nullish(), display_name: z.string().nullish() }).nullish(),
	items: z.object({ total: z.number().nullish() }).nullish(),
	tracks: z.object({ total: z.number().nullish() }).nullish(),
	snapshot_id: z.string().nullish(),
});

// One entry of a playlist's contents. Restricted renamed `track` to `item`.
export const playlistEntrySchema = z.object({
	added_at: z.string().nullish(),
	item: trackSchema.nullish(),
	track: trackSchema.nullish(),
});

export const savedTrackSchema = z.object({
	added_at: z.string().nullish(),
	item: trackSchema.nullish(),
	track: trackSchema.nullish(),
});

export const deviceSchema = z.object({
	id: z.string().nullish(),
	is_active: z.boolean(),
	name: z.string(),
	type: z.string().nullish(),
	volume_percent: z.number().nullish(),
});

export const devicesResponseSchema = z.object({ devices: z.array(deviceSchema) });

export const playbackStateSchema = z.object({
	device: deviceSchema.nullish(),
	is_playing: z.boolean(),
	progress_ms: z.number().nullish(),
	item: trackSchema.nullish(),
	shuffle_state: z.boolean().nullish(),
	repeat_state: z.string().nullish(),
	context: z.object({ type: z.string().nullish(), uri: z.string().nullish() }).nullish(),
});

export const queueSchema = z.object({
	currently_playing: trackSchema.nullish(),
	queue: z.array(trackSchema).nullish(),
});

export const recentlyPlayedSchema = z.object({
	items: z.array(
		z.object({
			track: trackSchema,
			played_at: z.string(),
			context: z.object({ type: z.string().nullish(), uri: z.string().nullish() }).nullish(),
		}),
	),
});

export const searchResponseSchema = z.object({
	tracks: pagingSchema(trackSchema.nullable()).nullish(),
	artists: pagingSchema(artistSchema.nullable()).nullish(),
	albums: pagingSchema(simplifiedAlbumSchema.nullable()).nullish(),
	playlists: pagingSchema(playlistSchema.nullable()).nullish(),
});

export const snapshotSchema = z.object({ snapshot_id: z.string().nullish() });

export type Artist = z.infer<typeof artistSchema>;
export type SimplifiedAlbum = z.infer<typeof simplifiedAlbumSchema>;
export type Album = z.infer<typeof albumSchema>;
export type Track = z.infer<typeof trackSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type PlaybackState = z.infer<typeof playbackStateSchema>;
