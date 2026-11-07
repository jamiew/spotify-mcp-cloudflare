import OAuthProvider, {
	OAuthError,
	type OAuthProviderOptions,
	type TokenExchangeCallbackOptions,
	type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createSpotifyServer } from "./server";
import { SpotifyAuthError, SpotifyClient } from "./spotify";
import { SpotifyHandler } from "./spotify-handler";
import {
	isAccountAllowed,
	type Props,
	propsSchema,
	refreshSpotifyToken,
	type SpotifyTokens,
} from "./utils";

/** Refresh Spotify when a client refreshes with less than this left on the token. */
const REFRESH_AHEAD_MS = 10 * 60_000;
/** MCP access tokens expire this long before the Spotify token they carry. */
const ACCESS_TOKEN_MARGIN_S = 5 * 60;
/** An API call whose Spotify token expires within this window gets a 401 instead. */
const STALE_TOKEN_MS = 60_000;

/** The regime belongs to the app, so every request in this isolate shares it. */
const fallbackFamilies = new Set<string>();

const isAllowed = (props: Props, env: Env) =>
	isAccountAllowed([props.email, props.userId, props.accountId], env.ALLOWED_EMAILS);

function accessTokenTTL(spotifyExpiresAt: number): number {
	const remaining = Math.floor((spotifyExpiresAt - Date.now()) / 1000);
	return Math.max(60, remaining - ACCESS_TOKEN_MARGIN_S);
}

/**
 * The grant owns the Spotify tokens. Each MCP refresh renews Spotify when it is
 * close to expiry and writes the result back, and every access token expires
 * before the Spotify token inside it. Concurrent sessions of one grant share
 * the same refresh chain instead of each holding a private copy.
 */
async function exchangeToken({
	grantType,
	props,
	env,
}: TokenExchangeCallbackOptions<Env>): Promise<TokenExchangeCallbackResult | undefined> {
	if (grantType !== "authorization_code" && grantType !== "refresh_token") return;
	const parsed = propsSchema.safeParse(props);
	if (!parsed.success) {
		throw new OAuthError("invalid_grant", { description: "Reconnect this server to Spotify." });
	}
	const current = parsed.data;
	if (grantType === "authorization_code")
		return { accessTokenTTL: accessTokenTTL(current.expiresAt) };
	if (!isAllowed(current, env)) {
		// Revokes the grant, so an allowlist removal ends access at the next refresh.
		throw new OAuthError("invalid_grant", { description: "This Spotify account is not allowed." });
	}
	if (current.expiresAt - Date.now() > REFRESH_AHEAD_MS) {
		return { accessTokenTTL: accessTokenTTL(current.expiresAt) };
	}
	let tokens: SpotifyTokens;
	try {
		tokens = await refreshSpotifyToken({
			clientId: env.SPOTIFY_CLIENT_ID,
			clientSecret: env.SPOTIFY_CLIENT_SECRET,
			refreshToken: current.refreshToken,
		});
	} catch (e) {
		if (e instanceof Error && e.message.includes("invalid_grant")) {
			// Spotify revoked the app: revoke this grant so the client signs in again.
			throw new OAuthError("invalid_grant", { description: "Spotify access was revoked." });
		}
		throw new OAuthError("temporarily_unavailable", {
			description: "Spotify could not refresh the session. Try again shortly.",
			statusCode: 503,
		});
	}
	const next: Props = {
		...current,
		accessToken: tokens.accessToken,
		// Spotify may rotate the refresh token; keep the old one when it doesn't.
		refreshToken: tokens.refreshToken ?? current.refreshToken,
		expiresAt: tokens.expiresAt,
	};
	return { newProps: next, accessTokenTTL: accessTokenTTL(next.expiresAt) };
}

/** Asks the client to refresh, which renews the Spotify token on the grant. */
function staleTokenResponse(request: Request): Response {
	const metadata = new URL("/.well-known/oauth-protected-resource/mcp", request.url);
	return new Response(null, {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="The Spotify session expired; refresh the access token", resource_metadata="${metadata.href}"`,
		},
	});
}

const mcpApi = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
		const parsed = propsSchema.safeParse(ctx.props);
		// Grants from before the provider refreshed Spotify carry an expired token.
		if (!parsed.success || parsed.data.expiresAt - Date.now() < STALE_TOKEN_MS) {
			return staleTokenResponse(request);
		}
		const props = parsed.data;
		const spotify = new SpotifyClient({
			fallbackFamilies,
			tokenProvider: {
				getAccessToken: async () => props.accessToken,
				// The grant, not this request, renews tokens. A 401 before expiry
				// means Spotify revoked access.
				refreshAccessToken: async () => {
					throw new SpotifyAuthError();
				},
			},
		});
		// Backup gate: the callback checks first, and refresh revokes removed accounts.
		const allowed = isAllowed(props, env);
		return createMcpHandler(() => createSpotifyServer(allowed ? () => spotify : undefined))(
			request,
			env,
			ctx,
		);
	},
};

/** Built per origin: the resource is every token's audience and must match the URL clients use. */
export function oauthOptions(origin: string): OAuthProviderOptions<Env> {
	const url = new URL(origin);
	// Only loopback may be plain http; Cloudflare also answers workers.dev over http.
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
	return {
		apiHandlers: { "/mcp": mcpApi },
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		defaultHandler: SpotifyHandler,
		resourceMetadata: { resource: new URL("/mcp", url).href, resource_name: "Spotify" },
		tokenExchangeCallback: exchangeToken,
		onError: ({ code, internal }) => console.warn(`oauth ${code}: ${internal.reason}`),
	};
}

const providers = new Map<string, OAuthProvider<Env>>();

export default {
	fetch(request, env, ctx) {
		const { origin } = new URL(request.url);
		let provider = providers.get(origin);
		if (!provider) {
			provider = new OAuthProvider(oauthOptions(origin));
			providers.set(origin, provider);
		}
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
