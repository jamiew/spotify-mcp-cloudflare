import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// The sibling repo is symlinked in and links back here, so vitest would
	// otherwise discover this suite a second time through the loop.
	test: { include: ["src/*.test.ts"], exclude: ["**/node_modules/**", "spotify-mcp/**"] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Stand-ins for the deployed secrets; Spotify itself is faked per test.
			miniflare: {
				bindings: {
					SPOTIFY_CLIENT_ID: "test-client-id",
					SPOTIFY_CLIENT_SECRET: "test-client-secret",
					COOKIE_ENCRYPTION_KEY: "test-cookie-key",
					ALLOWED_EMAILS: "allowed@example.com",
				},
			},
		}),
	],
});
