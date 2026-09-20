import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { version } from "../package.json";
import type { SpotifyClient } from "./spotify";
import { INSTRUCTIONS, registerTools } from "./tools";

// These public icons also work for local clients. Forks can replace the origin.
const ORIGIN = "https://spotify-mcp-cloudflare.jamie-7e9.workers.dev";

/** No token or transport state belongs in the shared MCP surface. */
export function createSpotifyServer(getSpotify?: () => SpotifyClient): McpServer {
	const server = new McpServer(
		{
			name: "spotify-mcp",
			title: "Spotify",
			version,
			description:
				"Search Spotify and manage playlists, library and playback for the signed-in user.",
			websiteUrl: "https://github.com/jamiew/spotify-mcp-cloudflare",
			icons: [
				{ src: `${ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["48x48"] },
				{ src: `${ORIGIN}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
			],
		},
		{
			instructions: INSTRUCTIONS,
			// Form responses must validate without eval/new Function in Workers.
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		},
	);
	// A denied Worker session deliberately exposes no tools or prompts.
	if (getSpotify) registerTools(server, getSpotify);
	return server;
}
