import { McpServer } from "@modelcontextprotocol/server";
import { version } from "../package.json";
import type { SpotifyClient } from "./spotify";
import { INSTRUCTIONS, registerTools } from "./tools";

// These public icons also work for local clients. Forks can replace the origin.
const ORIGIN = "https://spotify-mcp-cloudflare.jamie-7e9.workers.dev";

/**
 * Builds one MCP server. Stateless HTTP builds one per request and stdio one
 * per connection, so no token or transport state belongs here. The SDK picks a
 * JSON Schema validator per runtime; workerd's never generates code.
 */
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
		{ instructions: INSTRUCTIONS },
	);
	// A denied Worker request deliberately exposes no tools or prompts.
	if (getSpotify) registerTools(server, getSpotify);
	return server;
}
