import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocalTokenProvider, login } from "./local/auth";
import { LocalTokenStore, stateDirectory } from "./local/token-store";
import { createSpotifyServer } from "./server";
import { SpotifyClient, type TokenProvider } from "./spotify";

const NOT_SET_UP =
	"Spotify isn't set up for this local server. Set SPOTIFY_CLIENT_ID, run pnpm run login, then restart the server.";

/** Lets clients start the server and list tools before anyone has logged in. */
const notSetUp: TokenProvider = {
	getAccessToken: () => Promise.reject(new Error(NOT_SET_UP)),
	refreshAccessToken: () => Promise.reject(new Error(NOT_SET_UP)),
};

async function main(): Promise<void> {
	const [command, ...extra] = process.argv.slice(2);
	if (extra.length || (command !== undefined && command !== "login" && command !== "signout")) {
		throw new Error("Usage: pnpm --silent stdio | pnpm run login | pnpm signout");
	}
	const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
	if (command === "login" && !clientId) {
		throw new Error(
			"Set SPOTIFY_CLIENT_ID to your Spotify app's public client ID. No client secret is used locally.",
		);
	}
	const cancellation = new AbortController();
	const cancel = () => cancellation.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	let store: LocalTokenStore | undefined;
	try {
		// Serving without a client ID never touches the store, so it can't block a login.
		if (command !== undefined || clientId) store = await LocalTokenStore.acquire(stateDirectory());
		cancellation.signal.throwIfAborted();
		if (command === "signout" && store) {
			await store.clear();
			console.error(
				"Local Spotify tokens removed. To revoke Spotify's app grant too, use https://www.spotify.com/account/apps/.",
			);
			return;
		}
		if (command === "login" && clientId && store) {
			console.error(
				"Register http://127.0.0.1:8888/callback in your Spotify app. Open the following URL within five minutes:",
			);
			const tokens = await login({
				clientId,
				signal: cancellation.signal,
				onAuthorize: (url) => console.error(url),
			});
			await store.write(tokens);
			console.error("Spotify login saved. Start the local server with pnpm --silent stdio.");
			return;
		}
		const provider = clientId && store ? await LocalTokenProvider.load(store, clientId) : undefined;
		if (!provider) {
			// Free the lock so pnpm run login works while this server runs.
			await store?.close();
			store = undefined;
		}
		const client = new SpotifyClient({ tokenProvider: provider ?? notSetUp });
		// One server per connection; the opening exchange picks the protocol era.
		const stopped = Promise.withResolvers<void>();
		const stop = () => stopped.resolve();
		process.stdin.once("end", stop);
		process.stdin.once("error", stop);
		cancellation.signal.addEventListener("abort", stop, { once: true });
		const handle = serveStdio(() => createSpotifyServer(() => client), {
			onerror: (error) => console.error(error.message),
		});
		try {
			if (!cancellation.signal.aborted && !process.stdin.readableEnded) await stopped.promise;
		} finally {
			process.stdin.off("end", stop);
			process.stdin.off("error", stop);
			cancellation.signal.removeEventListener("abort", stop);
			try {
				await handle.close();
			} finally {
				// Wait for any refresh/save before handing the grant to another process.
				await provider?.close();
			}
		}
	} finally {
		try {
			await store?.close();
		} finally {
			process.off("SIGINT", cancel);
			process.off("SIGTERM", cancel);
		}
	}
}

main().catch((error: unknown) => {
	// stdout is reserved exclusively for MCP JSON-RPC, including startup failures.
	console.error(error instanceof Error ? error.message : "The local Spotify server failed.");
	process.exitCode = 1;
});
