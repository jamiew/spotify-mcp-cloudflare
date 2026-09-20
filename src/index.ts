import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { createSpotifyServer } from "./server";
import { SpotifyAuthError, SpotifyClient } from "./spotify";
import { SpotifyHandler } from "./spotify-handler";
import { isAccountAllowed, type Props, refreshSpotifyToken } from "./utils";

/** Working token state, persisted in the Durable Object. */
type State = {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	/** Scopes the stored token was minted with, so a re-scoped grant can replace it. */
	scope: string;
};
export class SpotifyMCP extends McpAgent<Env, State, Props> {
	server = createSpotifyServer();

	initialState: State = { accessToken: "", refreshToken: "", expiresAt: 0, scope: "" };

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
						// Refreshing can't change granted scopes; keep the seeding
						// grant's string so the comparison in init() stays stable.
						scope: this.state.scope,
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
		if (
			!isAccountAllowed(
				[this.props?.email, this.props?.userId, this.props?.accountId],
				this.env.ALLOWED_EMAILS,
			)
		) {
			return;
		}

		// Seed the persisted token state from the OAuth props on first run — and
		// again whenever the grant's scopes differ from what we've stored.
		// Refreshing only ever returns the scopes the token was minted with, so
		// without this a scope change could never take effect: the user would
		// re-authorize, Spotify would issue a correctly-scoped grant, and the DO
		// would keep refreshing the old one forever.
		if (this.props?.accessToken && this.props.scope !== this.state.scope) {
			this.setState({
				accessToken: this.props.accessToken,
				refreshToken: this.props.refreshToken,
				expiresAt: this.props.expiresAt,
				scope: this.props.scope,
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
		this.server = createSpotifyServer(() => {
			// An initialized session must not retain access after an allowlist change.
			if (
				!isAccountAllowed(
					[this.props?.email, this.props?.userId, this.props?.accountId],
					this.env.ALLOWED_EMAILS,
				)
			) {
				throw new SpotifyAuthError();
			}
			return this.client;
		});
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
