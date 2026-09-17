import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// The sibling repo is symlinked in and links back here, so vitest would
	// otherwise discover this suite a second time through the loop.
	test: { exclude: ["**/node_modules/**", "spotify-mcp/**"] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
