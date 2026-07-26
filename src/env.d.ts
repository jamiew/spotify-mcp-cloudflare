// Bindings available to the Worker. Runtime types live in the generated
// worker-configuration.d.ts (`pnpm cf-typegen`); this file owns the Env shape.
declare namespace Cloudflare {
	interface Env {
		/** KV namespace backing the OAuth provider (grants, tokens, clients, state). */
		OAUTH_KV: KVNamespace;
		/** Durable Object namespace for the SpotifyMCP agent. */
		MCP_OBJECT: DurableObjectNamespace;
		/** Spotify app Client ID (set via `wrangler secret put`). */
		SPOTIFY_CLIENT_ID: string;
		/** Spotify app Client Secret (set via `wrangler secret put`). */
		SPOTIFY_CLIENT_SECRET: string;
		/** Random secret used to sign the "approved clients" cookie. */
		COOKIE_ENCRYPTION_KEY: string;
		/**
		 * Optional comma-separated allowlist of Spotify account emails and/or user
		 * ids. If unset or empty, any Spotify account may authorize. Set via
		 * `wrangler secret put`.
		 */
		ALLOWED_EMAILS?: string;
	}
}

interface Env extends Cloudflare.Env {}
