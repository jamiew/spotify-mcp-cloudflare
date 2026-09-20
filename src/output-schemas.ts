import { z } from "zod";

// These describe the compact MCP payloads, not Spotify's untrimmed responses.
export const compactTrackSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	artist: z.string(),
	album: z.string().optional(),
	released: z.string().optional(),
	duration_ms: z.number().optional(),
	is_local: z.boolean().optional(),
});

export const compactArtistSchema = z.object({
	id: z.string(),
	name: z.string(),
	genres: z.array(z.string()).optional(),
	followers: z.number().optional(),
	popularity: z.number().optional(),
});

export const compactAlbumSchema = z.object({
	id: z.string(),
	name: z.string(),
	artist: z.string(),
	released: z.string().optional(),
	total_tracks: z.number().optional(),
});

export const compactPlaylistSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	public: z.boolean().optional(),
	owner: z.string(),
	track_count: z.number().nullable(),
	snapshot_id: z.string().optional(),
});

const acknowledgementSchema = z.object({
	status: z.literal("success"),
	message: z.string(),
});
const page = { total: z.number().nullable(), offset: z.number().int().nonnegative() };
const device = {
	id: z.string().optional(),
	name: z.string(),
	volume_percent: z.number().optional(),
};

export const outputSchemas = {
	get_me: z.object({
		id: z.string(),
		display_name: z.string().optional(),
		email: z.string().optional(),
		country: z.string().optional(),
		product: z.string().optional(),
	}),
	search_music: z.object({
		tracks: z.array(compactTrackSchema).optional(),
		artists: z.array(compactArtistSchema).optional(),
		albums: z.array(compactAlbumSchema).optional(),
		playlists: z.array(compactPlaylistSchema).optional(),
	}),
	get_tracks: z.object({
		tracks: z.array(
			compactTrackSchema.extend({
				explicit: z.boolean().optional(),
				track_number: z.number().optional(),
				album_id: z.string().optional(),
				artist_ids: z.array(z.string()).optional(),
			}),
		),
	}),
	get_artist: z.object({ artists: z.array(compactArtistSchema) }),
	get_artist_albums: z.object({ ...page, albums: z.array(compactAlbumSchema) }),
	get_album: z.object({
		albums: z.array(
			compactAlbumSchema.extend({
				album_type: z.string().optional(),
				tracks: z.array(compactTrackSchema.extend({ track_number: z.number().optional() })),
			}),
		),
	}),
	list_playlists: z.object({ ...page, playlists: z.array(compactPlaylistSchema) }),
	get_playlist: z.object({
		playlist: compactPlaylistSchema,
		total_tracks: z.number().nullable(),
		offset: z.number().int().nonnegative(),
		tracks: z.array(compactTrackSchema.extend({ position: z.number().int().nonnegative() })),
		contents_status: z.enum(["available", "inaccessible"]),
		returned: z.number().int().nonnegative(),
		next_offset: z.number().int().nonnegative().nullable(),
		complete: z.boolean(),
		truncated: z.boolean(),
		message: z.string().optional(),
	}),
	create_playlist: compactPlaylistSchema,
	update_playlist_details: acknowledgementSchema,
	add_tracks_to_playlist: z.object({ added: z.number().int(), snapshot_id: z.string().optional() }),
	remove_tracks_from_playlist: z.object({
		status: z.enum(["success", "cancelled"]),
		message: z.string(),
		removed: z.number().int(),
		snapshot_id: z.string().optional(),
	}),
	reorder_playlist: z.object({ reordered: z.literal(true), snapshot_id: z.string().optional() }),
	set_playlist_cover: acknowledgementSchema,
	follow_playlist: acknowledgementSchema,
	unfollow_playlist: acknowledgementSchema,
	get_saved_tracks: z.object({
		...page,
		tracks: z.array(compactTrackSchema.extend({ added_at: z.string().optional() })),
	}),
	save_tracks: acknowledgementSchema,
	remove_saved_tracks: acknowledgementSchema,
	get_saved_albums: z.object({
		...page,
		albums: z.array(compactAlbumSchema.extend({ added_at: z.string().optional() })),
	}),
	save_albums: acknowledgementSchema,
	remove_saved_albums: acknowledgementSchema,
	get_followed_artists: z.object({
		total: z.number().nullable(),
		artists: z.array(compactArtistSchema),
	}),
	follow_artists: acknowledgementSchema,
	unfollow_artists: acknowledgementSchema,
	check_library: z.object({
		kind: z.enum(["track", "album", "artist"]),
		items: z.array(z.object({ id: z.string(), in_library: z.boolean() })),
	}),
	get_playback_state: z.object({
		is_playing: z.boolean(),
		track: compactTrackSchema.nullable(),
		progress_ms: z.number().optional(),
		shuffle: z.boolean().optional(),
		repeat: z.string().optional(),
		device: z.object(device).optional(),
		context: z.string().optional(),
		message: z.string().optional(),
	}),
	control_playback: acknowledgementSchema,
	get_queue: z.object({
		currently_playing: compactTrackSchema.nullable(),
		queue: z.array(compactTrackSchema),
	}),
	add_to_queue: acknowledgementSchema,
	list_devices: z.object({
		devices: z.array(z.object({ ...device, type: z.string().optional(), is_active: z.boolean() })),
	}),
	transfer_playback: acknowledgementSchema,
	get_recently_played: z.object({
		tracks: z.array(
			compactTrackSchema.extend({ played_at: z.string(), context: z.string().optional() }),
		),
	}),
	get_top_items: z.object({
		artists: z.array(compactArtistSchema).optional(),
		tracks: z.array(compactTrackSchema).optional(),
	}),
};
