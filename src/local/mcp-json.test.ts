// Launches the local entry from .mcp.json exactly as a client would, with
// synthetic tokens, and checks the tool surface on both protocol eras. Listing
// tools never calls Spotify, so this needs no network or secrets.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { version } from "../../package.json";
import { SPOTIFY_SCOPES } from "../utils";
import { LocalTokenStore } from "./token-store";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const mcpJson = z.object({
	mcpServers: z.object({
		"spotify-local": z.object({
			type: z.literal("stdio"),
			command: z.string(),
			args: z.array(z.string()),
		}),
	}),
});

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

/** A private token directory holding a login that won't need refreshing. */
async function syntheticLogin(clientId: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "spotify-mcp-json-test-"));
	directories.push(directory);
	const store = await LocalTokenStore.acquire(directory);
	await store.write({
		version: 1,
		clientId,
		accessToken: "synthetic-access",
		refreshToken: "synthetic-refresh",
		expiresAt: Date.now() + 3_600_000,
		scope: SPOTIFY_SCOPES,
	});
	await store.close();
	return directory;
}

describe(".mcp.json local entry", () => {
	it.each(["modern", "legacy"] as const)(
		"serves the tool surface with explicit hints on the %s era",
		async (era) => {
			const config = mcpJson.parse(JSON.parse(await readFile(join(ROOT, ".mcp.json"), "utf8")));
			const entry = config.mcpServers["spotify-local"];
			const expand = (value: string) => value.replace(/\$\{CLAUDE_PROJECT_DIR:-\.\}/g, ROOT);
			const clientId = "synthetic-client";
			const client = new Client(
				{ name: "mcp-json-test", version: "0" },
				era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
			);
			await client.connect(
				new StdioClientTransport({
					command: expand(entry.command),
					args: entry.args.map(expand),
					env: {
						SPOTIFY_CLIENT_ID: clientId,
						SPOTIFY_MCP_STATE_DIR: await syntheticLogin(clientId),
					},
				}),
			);
			try {
				expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(era === "modern");
				expect(client.getServerVersion()?.version).toBe(version);
				const { tools } = await client.listTools();
				expect(tools.length).toBeGreaterThan(0);
				for (const tool of tools) {
					const hints = tool.annotations ?? {};
					expect(tool.title, tool.name).toBeTruthy();
					expect(tool.outputSchema, tool.name).toBeDefined();
					expect(hints.readOnlyHint, tool.name).toBeTypeOf("boolean");
					// The spec defaults destructiveHint to true, so an unmarked save looks like a delete.
					if (!hints.readOnlyHint) {
						expect(hints.destructiveHint, tool.name).toBeTypeOf("boolean");
					}
				}
			} finally {
				await client.close();
			}
		},
		30_000,
	);
});
