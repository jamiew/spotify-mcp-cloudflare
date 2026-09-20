import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { SpotifyAuthError, type TokenProvider } from "../spotify";
import { SPOTIFY_AUTH_URL, SPOTIFY_SCOPES, SPOTIFY_TOKEN_URL } from "../utils";
import type { LocalTokenStore, LocalTokens } from "./token-store";

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
	expires_in: z.number().int().positive(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
});

async function requestToken(
	body: URLSearchParams,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<z.infer<typeof tokenResponseSchema>> {
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		redirect: "error",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		// Do not forward upstream bodies: they may contain credentials or user data.
		const error = z
			.object({ error: z.string() })
			.safeParse(await response.json().catch(() => null));
		if (error.success && error.data.error === "invalid_grant") {
			const expired = new SpotifyAuthError();
			expired.message =
				"Spotify authorization has lapsed. Stop the local server and run pnpm run login again.";
			throw expired;
		}
		throw new Error(
			`Spotify authorization request failed (HTTP ${response.status}). Run pnpm run login again if needed.`,
		);
	}
	const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
	if (!parsed.success) throw new Error("Spotify returned an invalid token response.");
	return parsed.data;
}

function requireScopes(scope: string): void {
	const granted = new Set(scope.split(/\s+/));
	if (SPOTIFY_SCOPES.split(" ").some((required) => !granted.has(required))) {
		throw new Error(
			"Spotify permissions have changed or were not fully granted. Stop the local server and run pnpm run login again.",
		);
	}
}

/** An explicit login only: serving MCP never starts an OAuth listener or browser. */
export async function login(options: {
	clientId: string;
	onAuthorize: (url: string) => void;
	signal?: AbortSignal;
	callbackPort?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<LocalTokens> {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 300_000)])
		: AbortSignal.timeout(options.timeoutMs ?? 300_000);
	signal.throwIfAborted();
	const callback = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 });
	let stopWaiting: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			callback.once("error", reject);
			callback.listen(options.callbackPort ?? 8888, "127.0.0.1", () => {
				callback.off("error", reject);
				resolve();
			});
		});
		const address = callback.address();
		if (!address || typeof address === "string")
			throw new Error("Could not start the local OAuth callback.");
		const callbackOrigin = `http://127.0.0.1:${address.port}`;
		const redirectUri = `${callbackOrigin}/callback`;
		const authorization = new URL(SPOTIFY_AUTH_URL);
		authorization.search = new URLSearchParams({
			client_id: options.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SPOTIFY_SCOPES,
			state,
			code_challenge_method: "S256",
			code_challenge: challenge,
		}).toString();
		const code = await new Promise<string>((resolve, reject) => {
			let completed = false;
			const abort = () =>
				reject(
					new Error("Spotify login timed out or was cancelled. Run pnpm run login to try again."),
				);
			const fail = (error: Error) => reject(error);
			stopWaiting = () => {
				signal.removeEventListener("abort", abort);
				callback.off("error", fail);
			};
			signal.addEventListener("abort", abort, { once: true });
			callback.once("error", fail);
			callback.on("request", (request, response) => {
				response.setHeader("Content-Type", "text/plain; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response.setHeader("Referrer-Policy", "no-referrer");
				let url: URL;
				try {
					url = new URL(request.url ?? "", redirectUri);
				} catch {
					response.writeHead(400).end("Invalid callback.");
					return;
				}
				if (
					request.method !== "GET" ||
					request.headers.host !== `127.0.0.1:${address.port}` ||
					url.origin !== callbackOrigin ||
					url.pathname !== "/callback"
				) {
					response.writeHead(404).end("Not found.");
					return;
				}
				if (completed) {
					response.writeHead(409).end("This login callback was already used.");
					return;
				}
				completed = true;
				const received = Buffer.from(url.searchParams.get("state") ?? "");
				const expected = Buffer.from(state);
				if (
					url.searchParams.getAll("state").length !== 1 ||
					received.length !== expected.length ||
					!timingSafeEqual(received, expected)
				) {
					response.writeHead(400).end("State verification failed. Start login again.", () => {
						reject(new Error("Spotify OAuth state verification failed; no tokens were exchanged."));
					});
					return;
				}
				const value = url.searchParams.get("code");
				if (
					url.searchParams.has("error") ||
					!value ||
					url.searchParams.getAll("code").length !== 1
				) {
					response
						.writeHead(400)
						.end("Authorization was denied or incomplete. Start login again.", () => {
							reject(
								new Error(
									"Spotify authorization was denied or the callback contained no unambiguous code.",
								),
							);
						});
					return;
				}
				response.end("Authorization received. Return to your terminal to finish login.", () =>
					resolve(value),
				);
			});
			if (signal.aborted) abort();
			else options.onAuthorize(authorization.href);
		});
		stopWaiting?.();
		const tokens = await requestToken(
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: options.clientId,
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}),
			options.fetchImpl ?? fetch,
			signal,
		);
		if (!tokens.refresh_token)
			throw new Error("Spotify did not return a refresh token. Run login again.");
		const scope = tokens.scope ?? SPOTIFY_SCOPES;
		requireScopes(scope);
		return {
			version: 1,
			clientId: options.clientId,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
			scope,
		};
	} finally {
		stopWaiting?.();
		callback.closeAllConnections();
		await new Promise<void>((resolve) => callback.close(() => resolve()));
	}
}

/** The store's lifetime lock makes this the only refresh owner across processes. */
export class LocalTokenProvider implements TokenProvider {
	private refreshInFlight: Promise<string> | null = null;
	private closed = false;
	private failure: Error | null = null;

	private constructor(
		private readonly store: LocalTokenStore,
		private tokens: LocalTokens,
		private readonly fetchImpl: typeof fetch,
	) {}

	static async load(
		store: LocalTokenStore,
		clientId: string,
		fetchImpl: typeof fetch = fetch,
	): Promise<LocalTokenProvider> {
		const tokens = await store.read();
		if (!tokens)
			throw new Error("No local Spotify login. Run pnpm run login before starting the server.");
		if (tokens.clientId !== clientId)
			throw new Error(
				"The stored login belongs to a different SPOTIFY_CLIENT_ID. Run pnpm run login again.",
			);
		requireScopes(tokens.scope);
		return new LocalTokenProvider(store, tokens, fetchImpl);
	}

	async getAccessToken(): Promise<string> {
		if (this.closed) throw new Error("The local Spotify server is shutting down.");
		if (this.failure) throw this.failure;
		if (this.refreshInFlight) return this.refreshInFlight;
		if (Date.now() + 60_000 >= this.tokens.expiresAt) return this.refreshAccessToken();
		return this.tokens.accessToken;
	}

	async refreshAccessToken(): Promise<string> {
		if (this.closed) throw new Error("The local Spotify server is shutting down.");
		if (this.failure) throw this.failure;
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.refresh().finally(() => {
				this.refreshInFlight = null;
			});
		}
		return this.refreshInFlight;
	}

	private async refresh(): Promise<string> {
		try {
			const response = await requestToken(
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: this.tokens.clientId,
					refresh_token: this.tokens.refreshToken,
				}),
				this.fetchImpl,
			);
			const tokens: LocalTokens = {
				...this.tokens,
				accessToken: response.access_token,
				refreshToken: response.refresh_token ?? this.tokens.refreshToken,
				expiresAt: Date.now() + response.expires_in * 1000,
				scope: response.scope ?? this.tokens.scope,
			};
			// Never use or expose a rotated token until it is durably saved.
			await this.store.write(tokens);
			this.tokens = tokens;
			requireScopes(tokens.scope);
			return tokens.accessToken;
		} catch (error) {
			// A failed exchange/save can have consumed the old refresh token. Do not
			// keep retrying that grant in this process, including parallel 401 retries.
			this.failure =
				error instanceof SpotifyAuthError
					? error
					: new Error(
							"Could not refresh and safely save Spotify authorization. Restart the local server; if it still fails, run pnpm run login again.",
						);
			throw this.failure;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.refreshInFlight?.catch(() => {});
	}
}
