// Live e2e smoke test: connects to the deployed MCP server as a real OAuth
// client (dynamic registration + PKCE; opens your browser once, then caches
// tokens in .e2e-auth.json) and exercises read-only tools.
//
//   pnpm e2e                       # against the deployed worker
//   E2E_SERVER=http://localhost:8788 pnpm e2e   # against wrangler dev
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = process.env.E2E_SERVER ?? "https://spotify-mcp-cloudflare.jamie-7e9.workers.dev";
const CALLBACK_PORT = 8976;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const AUTH_CACHE = new URL("../.e2e-auth.json", import.meta.url).pathname;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON cache, shapes owned by the SDK
type Cache = Record<string, any>;

function loadCache(): Cache {
	try {
		return JSON.parse(readFileSync(AUTH_CACHE, "utf8"));
	} catch {
		return {};
	}
}

function saveCache(cache: Cache) {
	writeFileSync(AUTH_CACHE, JSON.stringify(cache, null, 2));
}

const cache = loadCache();

const provider: OAuthClientProvider = {
	get redirectUrl() {
		return CALLBACK_URL;
	},
	get clientMetadata() {
		return {
			client_name: "spotify-mcp-cloudflare e2e",
			redirect_uris: [CALLBACK_URL],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	},
	clientInformation: () => cache.clientInformation,
	saveClientInformation(info) {
		cache.clientInformation = info;
		saveCache(cache);
	},
	tokens: () => cache.tokens,
	saveTokens(tokens) {
		cache.tokens = tokens;
		saveCache(cache);
	},
	redirectToAuthorization(url) {
		console.log(`\nOpening browser to authorize:\n  ${url.href}\n`);
		spawn("open", [url.href], { stdio: "ignore", detached: true }).unref();
	},
	saveCodeVerifier(verifier) {
		cache.codeVerifier = verifier;
		saveCache(cache);
	},
	codeVerifier: () => cache.codeVerifier,
	invalidateCredentials(scope) {
		if (scope === "all") {
			delete cache.clientInformation;
			delete cache.tokens;
		}
		if (scope === "all" || scope === "tokens") delete cache.tokens;
		if (scope === "all" || scope === "verifier") delete cache.codeVerifier;
		saveCache(cache);
	},
};

function waitForCallbackCode(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", CALLBACK_URL);
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<h3>e2e: you can close this tab</h3>");
			server.close();
			if (code) resolve(code);
			else reject(new Error(`authorization failed: ${error ?? "no code in callback"}`));
		});
		server.listen(CALLBACK_PORT);
		setTimeout(() => {
			server.close();
			reject(new Error("timed out waiting for browser authorization (120s)"));
		}, 120_000).unref();
	});
}

function makeTransport() {
	return new StreamableHTTPClientTransport(new URL("/mcp", SERVER), {
		authProvider: provider,
	});
}

async function connect(): Promise<Client> {
	const client = new Client({ name: "e2e-smoke", version: "0.0.1" });
	const transport = makeTransport();
	try {
		await client.connect(transport);
		return client;
	} catch (e) {
		if (!(e instanceof UnauthorizedError)) throw e;
		const code = await waitForCallbackCode();
		await transport.finishAuth(code);
		const retryClient = new Client({ name: "e2e-smoke", version: "0.0.1" });
		await retryClient.connect(makeTransport());
		return retryClient;
	}
}

let failures = 0;

// biome-ignore lint/suspicious/noExplicitAny: tool results inspected loosely on purpose
function check(name: string, condition: boolean, detail?: any) {
	const mark = condition ? "ok " : "FAIL";
	console.log(`  [${mark}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
	if (!condition) failures += 1;
}

// biome-ignore lint/suspicious/noExplicitAny: structuredContent is schemaless here
function structured(result: any): any {
	if (result.structuredContent) return result.structuredContent;
	try {
		return JSON.parse(result.content?.[0]?.text ?? "null");
	} catch {
		return undefined; // plain-text result like "No active playback."
	}
}

async function main() {
	console.log(`e2e against ${SERVER}`);

	// Unauthenticated surface
	const meta = await fetch(new URL("/.well-known/oauth-authorization-server", SERVER));
	check("oauth discovery metadata", meta.status === 200);
	const bare = await fetch(new URL("/mcp", SERVER), { method: "POST" });
	check(
		"unauthenticated /mcp is 401 + WWW-Authenticate",
		bare.status === 401 && (bare.headers.get("www-authenticate") ?? "").includes("Bearer"),
	);

	// Authenticated MCP session
	const client = await connect();
	console.log("  connected (OAuth ok)");

	const tools = await client.listTools();
	check("lists 24 tools", tools.tools.length === 24, tools.tools.length);
	const names = tools.tools.map((t) => t.name);
	for (const expected of ["search_music", "get_playlist", "control_playback", "get_top_items"]) {
		check(`tool registered: ${expected}`, names.includes(expected));
	}

	const me = structured(await client.callTool({ name: "get_me", arguments: {} }));
	check("get_me returns a user id", typeof me?.id === "string", me?.id);

	const searchRes = structured(
		await client.callTool({
			name: "search_music",
			arguments: { query: "radiohead", types: ["track", "artist"], limit: 3 },
		}),
	);
	check(
		"search_music returns tracks + artists",
		Array.isArray(searchRes?.tracks) && Array.isArray(searchRes?.artists),
		searchRes?.tracks?.[0]?.name,
	);

	const playlists = structured(
		await client.callTool({ name: "list_playlists", arguments: { limit: 5 } }),
	);
	check("list_playlists returns playlists", Array.isArray(playlists?.playlists), {
		count: playlists?.playlists?.length,
		total: playlists?.total,
	});

	const saved = structured(
		await client.callTool({ name: "get_saved_tracks", arguments: { limit: 3 } }),
	);
	check("get_saved_tracks returns tracks", Array.isArray(saved?.tracks), {
		count: saved?.tracks?.length,
	});

	// May legitimately be "No active playback." (plain text, no structure)
	const playback = await client.callTool({ name: "get_playback_state", arguments: {} });
	check("get_playback_state answers", playback.isError !== true, structured(playback) ?? "idle");

	const top = structured(
		await client.callTool({ name: "get_top_items", arguments: { type: "artists", limit: 3 } }),
	);
	check(
		"get_top_items returns artists",
		Array.isArray(top?.artists),
		top?.artists?.map((a: { name: string }) => a.name),
	);

	await client.close();
	console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("e2e crashed:", e);
	process.exit(1);
});
