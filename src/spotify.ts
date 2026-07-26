// Typed Spotify Web API client: transparent 401 refresh-and-retry, bounded 429
// backoff, Zod-validated responses, and per-endpoint-family fallback between
// the restricted (Feb 2026) and legacy API regimes.

import type { z } from "zod";

export const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";

export class SpotifyApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public reason?: string,
	) {
		super(message);
		this.name = "SpotifyApiError";
	}
}

/** Authorization is gone for good (refresh failed or double 401). */
export class SpotifyAuthError extends Error {
	constructor() {
		super("Spotify authorization has lapsed. Reconnect this MCP server to Spotify.");
		this.name = "SpotifyAuthError";
	}
}

export class RateLimitedError extends Error {
	constructor(public retryAfterSeconds?: number) {
		super("Spotify is rate limiting right now. Wait a moment and try again.");
		this.name = "RateLimitedError";
	}
}

export class ResponseShapeError extends Error {
	constructor(path: string, detail: string) {
		super(`Spotify returned an unexpected shape for ${path}: ${detail}`);
		this.name = "ResponseShapeError";
	}
}

export function isPremiumRequiredError(error: unknown): boolean {
	return (
		error instanceof SpotifyApiError &&
		error.status === 403 &&
		(error.reason ?? "").toUpperCase().includes("PREMIUM")
	);
}

export function isNoActiveDeviceError(error: unknown): boolean {
	return (
		error instanceof SpotifyApiError &&
		error.status === 404 &&
		(error.reason ?? "").toUpperCase().includes("NO_ACTIVE_DEVICE")
	);
}

export interface TokenProvider {
	/** Returns a currently valid access token, refreshing proactively near expiry. */
	getAccessToken(): Promise<string>;
	/** Forces a refresh (called after an unexpected 401). Returns the new token. */
	refreshAccessToken(): Promise<string>;
}

export interface RequestSpec {
	method?: "GET" | "POST" | "PUT" | "DELETE";
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
}

export interface SpotifyClientOptions {
	tokenProvider: TokenProvider;
	apiBaseUrl?: string;
	fetchImpl?: typeof fetch;
	maxRateLimitRetries?: number;
	/** Never sleep longer than this per 429, in seconds. */
	maxRetryAfterSeconds?: number;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SpotifyClient {
	private readonly tokenProvider: TokenProvider;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxRateLimitRetries: number;
	private readonly maxRetryAfterSeconds: number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** Endpoint families confirmed to need the legacy path (cached per session). */
	private readonly legacyFamilies = new Set<string>();

	constructor(options: SpotifyClientOptions) {
		this.tokenProvider = options.tokenProvider;
		this.baseUrl = (options.apiBaseUrl ?? SPOTIFY_API_BASE_URL).replace(/\/+$/, "");
		// Bind: workers' native fetch throws "Illegal invocation" if called as a method.
		this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
		this.maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
		this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 5;
		this.sleep = options.sleep ?? defaultSleep;
	}

	/** Request and Zod-parse a JSON response. Empty bodies parse as undefined. */
	async request<T>(path: string, schema: z.ZodType<T>, spec: RequestSpec = {}): Promise<T> {
		const raw = await this.requestRaw(path, spec);
		const parsed = schema.safeParse(raw);
		if (!parsed.success) {
			const detail = parsed.error.issues
				.slice(0, 3)
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			throw new ResponseShapeError(path, detail);
		}
		return parsed.data;
	}

	/** Request where the response body doesn't matter (mutations). */
	async requestVoid(path: string, spec: RequestSpec = {}): Promise<void> {
		await this.requestRaw(path, spec);
	}

	/**
	 * Tries the restricted-regime request first, falling back to the legacy
	 * shape on 404/405/410 and remembering the answer for the session. Safe for
	 * mutations: those statuses mean the route wasn't served.
	 */
	async withFallback<T>(
		family: string,
		restricted: () => Promise<T>,
		legacy: () => Promise<T>,
	): Promise<T> {
		if (this.legacyFamilies.has(family)) {
			return legacy();
		}
		try {
			return await restricted();
		} catch (error) {
			if (
				error instanceof SpotifyApiError &&
				(error.status === 404 || error.status === 405 || error.status === 410) &&
				// A 404 naming a playback problem is a real 404, not a regime miss.
				!isNoActiveDeviceError(error)
			) {
				// Only cache the family as legacy if the legacy shape works; a
				// genuine not-found fails both ways and caches nothing.
				const result = await legacy();
				this.legacyFamilies.add(family);
				return result;
			}
			throw error;
		}
	}

	private async requestRaw(path: string, spec: RequestSpec): Promise<unknown> {
		const url = this.buildUrl(path, spec.query);
		let token = await this.tokenProvider.getAccessToken();
		let refreshed = false;
		let rateLimitRetries = 0;

		for (;;) {
			const response = await this.send(url, token, spec);

			if (response.status === 401) {
				if (refreshed) throw new SpotifyAuthError();
				refreshed = true;
				token = await this.tokenProvider.refreshAccessToken();
				continue;
			}

			if (response.status === 429) {
				if (rateLimitRetries >= this.maxRateLimitRetries) {
					throw new RateLimitedError(this.retryAfterSeconds(response));
				}
				rateLimitRetries += 1;
				const waitSeconds = Math.min(
					this.retryAfterSeconds(response) ?? 1,
					this.maxRetryAfterSeconds,
				);
				await this.sleep(waitSeconds * 1000);
				continue;
			}

			if (!response.ok) {
				throw new SpotifyApiError(
					`Spotify returned ${response.status} for ${spec.method ?? "GET"} ${path}`,
					response.status,
					await this.extractReason(response),
				);
			}

			if (response.status === 204) return undefined;
			const text = await response.text();
			if (text.length === 0) return undefined;
			try {
				return JSON.parse(text);
			} catch {
				throw new ResponseShapeError(path, "response was not valid JSON");
			}
		}
	}

	/** Walks offset pagination up to `total` items, `perRequest` at a time. */
	async paginate<T>(
		fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; hasNext: boolean }>,
		{ total, perRequest }: { total: number; perRequest: number },
	): Promise<T[]> {
		const collected: T[] = [];
		let offset = 0;
		while (collected.length < total) {
			const limit = Math.min(perRequest, total - collected.length);
			const page = await fetchPage(limit, offset);
			collected.push(...page.items);
			if (page.items.length < limit || !page.hasNext) break;
			offset += page.items.length;
		}
		return collected.slice(0, total);
	}

	private buildUrl(
		path: string,
		query?: Record<string, string | number | boolean | undefined>,
	): string {
		const url = new URL(this.baseUrl + path);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}

	private async send(url: string, token: string, spec: RequestSpec): Promise<Response> {
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		let body: string | undefined;
		if (spec.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(spec.body);
		}
		return this.fetchImpl(url, {
			method: spec.method ?? "GET",
			headers,
			...(body !== undefined ? { body } : {}),
		});
	}

	private retryAfterSeconds(response: Response): number | undefined {
		const header = response.headers.get("Retry-After");
		if (header === null) return undefined;
		const parsed = Number(header);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}

	/** Pulls a machine-readable reason out of an error body. */
	private async extractReason(response: Response): Promise<string | undefined> {
		try {
			const body: unknown = await response.json();
			if (typeof body === "object" && body !== null && "error" in body) {
				const err = body.error;
				if (typeof err === "object" && err !== null) {
					const reason = "reason" in err && typeof err.reason === "string" ? err.reason : undefined;
					const message =
						"message" in err && typeof err.message === "string" ? err.message : undefined;
					return reason ?? message;
				}
			}
			return undefined;
		} catch {
			return undefined;
		}
	}
}

/** Normalizes a bare ID or URI into a full Spotify URI of the given kind. */
export function toUri(kind: string, idOrUri: string): string {
	return idOrUri.includes(":") ? idOrUri : `spotify:${kind}:${idOrUri}`;
}

/** Strips a `spotify:kind:` prefix if present, returning the bare ID. */
export function toId(idOrUri: string): string {
	const parts = idOrUri.split(":");
	return parts[parts.length - 1] || idOrUri;
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
