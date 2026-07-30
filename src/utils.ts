// Spotify OAuth helpers for the upstream (Spotify) side of the flow.

export const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Scopes requested from Spotify. Mirrors the original stdio server. */
export const SPOTIFY_SCOPES = [
	"playlist-read-private",
	"playlist-read-collaborative",
	"playlist-modify-public",
	"playlist-modify-private",
	"user-library-read",
	"user-library-modify",
	"user-follow-read",
	"user-follow-modify",
	"ugc-image-upload",
	"user-top-read",
	"user-read-recently-played",
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"user-read-private",
	"user-read-email",
].join(" ");

/**
 * Access control by Spotify account.
 *
 * `allowedRaw` is the `ALLOWED_EMAILS` secret: a comma-separated list of
 * permitted emails and/or Spotify user ids. Newer Spotify apps no longer see
 * the account email on /me, so ids keep the allowlist usable there. Empty or
 * unset means the server is open to any Spotify account. Anyone not on a
 * configured list is rejected at the OAuth callback.
 */
export function isAccountAllowed(
	identifiers: (string | undefined | null)[],
	allowedRaw: string | undefined | null,
): boolean {
	const allow = (allowedRaw ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (allow.length === 0) return true; // no restriction configured
	return identifiers.some((id) => !!id && allow.includes(id.toLowerCase()));
}

/**
 * Context from the auth process, encrypted and stored in the issued OAuth
 * token, then provided to the McpAgent as `this.props`.
 */
export type Props = {
	userId: string;
	displayName: string;
	email: string;
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds at which `accessToken` expires. */
	expiresAt: number;
	/** Scopes this grant was actually minted with, per Spotify's token response. */
	scope: string;
};

/** Shape of Spotify's token endpoint JSON response. */
interface SpotifyTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

/** Normalized token bundle used across the worker. */
export interface SpotifyTokens {
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	/** Space-separated scopes Spotify granted, which can lag what we requested. */
	scope: string;
}

/**
 * Builds Spotify's authorization URL to which the user's browser is redirected.
 */
export function getUpstreamAuthorizeUrl({
	clientId,
	scope,
	redirectUri,
	state,
}: {
	clientId: string;
	scope: string;
	redirectUri: string;
	state: string;
}): string {
	const upstream = new URL(SPOTIFY_AUTH_URL);
	upstream.searchParams.set("client_id", clientId);
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("state", state);
	return upstream.href;
}

/**
 * Low-level call to Spotify's token endpoint. Spotify returns JSON and expects
 * the client credentials via HTTP Basic auth. Throws on any non-2xx response.
 */
async function requestToken(
	clientId: string,
	clientSecret: string,
	body: Record<string, string>,
): Promise<SpotifyTokenResponse> {
	const resp = await fetch(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
		},
		body: new URLSearchParams(body).toString(),
	});
	if (!resp.ok) {
		throw new Error(`Spotify token request failed (${resp.status}): ${await resp.text()}`);
	}
	return (await resp.json()) as SpotifyTokenResponse;
}

/**
 * Exchanges an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForToken(opts: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}): Promise<Required<SpotifyTokens>> {
	const tr = await requestToken(opts.clientId, opts.clientSecret, {
		grant_type: "authorization_code",
		code: opts.code,
		redirect_uri: opts.redirectUri,
	});
	if (!tr.refresh_token) {
		throw new Error("Spotify did not return a refresh token");
	}
	return {
		accessToken: tr.access_token,
		refreshToken: tr.refresh_token,
		expiresAt: Date.now() + tr.expires_in * 1000,
		scope: tr.scope ?? "",
	};
}

/**
 * Uses a refresh token to obtain a fresh access token. Spotify may or may not
 * return a new refresh token; when omitted, the caller should keep the old one.
 */
export async function refreshSpotifyToken(opts: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<SpotifyTokens> {
	const tr = await requestToken(opts.clientId, opts.clientSecret, {
		grant_type: "refresh_token",
		refresh_token: opts.refreshToken,
	});
	return {
		accessToken: tr.access_token,
		refreshToken: tr.refresh_token,
		expiresAt: Date.now() + tr.expires_in * 1000,
		scope: tr.scope ?? "",
	};
}
