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
	constructor(
		public retryAfterSeconds?: number,
		public quotaExceeded = false,
	) {
		super(
			quotaExceeded
				? "Spotify's daily API quota for this developer account is used up. Retrying will not help; it resets within 24 hours."
				: "Spotify is rate limiting right now. Wait a moment and try again.",
		);
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
	/** Sends this verbatim instead of JSON — the playlist cover upload is image/jpeg. */
	raw?: { contentType: string; body: string };
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

// 400 is here because the restricted /me/library endpoints reject rather than
// 404 when the app is on the legacy regime.
const REGIME_MISS_STATUSES = [400, 404, 405, 410];

export class SpotifyClient {
	private readonly tokenProvider: TokenProvider;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxRateLimitRetries: number;
	private readonly maxRetryAfterSeconds: number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** Endpoint families confirmed to need their fallback path (cached per session). */
	private readonly fallbackFamilies = new Set<string>();

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
	 * Tries the preferred request first (the restricted-regime shape, usually),
	 * falling back to the alternative when the status says the route isn't
	 * served, and remembering the answer for the session. Safe for mutations:
	 * those statuses mean the route wasn't served. Pass `fallbackOn` for routes
	 * Spotify withholds with a 403 instead, such as batch reads.
	 */
	async withFallback<T>(
		family: string,
		preferred: () => Promise<T>,
		fallback: () => Promise<T>,
		fallbackOn: number[] = REGIME_MISS_STATUSES,
	): Promise<T> {
		if (this.fallbackFamilies.has(family)) {
			return fallback();
		}
		try {
			return await preferred();
		} catch (error) {
			if (
				error instanceof SpotifyApiError &&
				fallbackOn.includes(error.status) &&
				// A 404 naming a playback problem is a real 404, not a regime miss.
				!isNoActiveDeviceError(error)
			) {
				// Only cache the family if the fallback works; a genuine not-found
				// fails both ways and caches nothing.
				const result = await fallback();
				this.fallbackFamilies.add(family);
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
				// Since July 2026 quota is counted per developer account and a 429
				// carrying QUOTA_EXCEEDED cannot clear by waiting, so a retry only
				// burns the pool shared by every app on the account.
				if ((await this.extractReason(response))?.toUpperCase().includes("QUOTA_EXCEEDED")) {
					throw new RateLimitedError(this.retryAfterSeconds(response), true);
				}
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
		if (spec.raw !== undefined) {
			headers["Content-Type"] = spec.raw.contentType;
			body = spec.raw.body;
		} else if (spec.body !== undefined) {
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
		const text = await response.text().catch(() => "");
		if (text.length === 0) return undefined;
		try {
			const body: unknown = JSON.parse(text);
			if (typeof body === "object" && body !== null && "error" in body) {
				const err = body.error;
				if (typeof err === "object" && err !== null) {
					const reason = "reason" in err && typeof err.reason === "string" ? err.reason : undefined;
					const message =
						"message" in err && typeof err.message === "string" ? err.message : undefined;
					if (reason ?? message) return reason ?? message;
				}
				// OAuth-style bodies put a string in `error` and detail alongside it.
				if (typeof err === "string") {
					const description =
						"error_description" in body && typeof body.error_description === "string"
							? body.error_description
							: undefined;
					return description ? `${err}: ${description}` : err;
				}
			}
		} catch {
			// Not JSON — fall through to the raw body.
		}
		return text.slice(0, 200);
	}
}

/**
 * Reads the kind and id out of a `spotify:` URI or an open.spotify.com share
 * URL. Legacy playlist URIs (`spotify:user:x:playlist:y`) and local-file URIs
 * carry extra segments; the id is always the last one.
 */
function parseRef(ref: string): { kind: string; id: string } | undefined {
	if (ref.startsWith("spotify:")) {
		const parts = ref.split(":");
		const kind = parts[1];
		const id = parts[parts.length - 1];
		return kind && id ? { kind, id } : undefined;
	}
	const url = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?([a-z]+)\/([A-Za-z0-9]+)/.exec(
		ref,
	);
	const kind = url?.[1];
	const id = url?.[2];
	return kind && id ? { kind, id } : undefined;
}

/** Normalizes a bare ID, `spotify:` URI or share URL into a full Spotify URI. */
export function toUri(kind: string, ref: string): string {
	const parsed = parseRef(ref);
	return parsed ? `spotify:${parsed.kind}:${parsed.id}` : `spotify:${kind}:${ref}`;
}

/** Strips a `spotify:kind:` prefix or share-URL wrapper, returning the bare ID. */
export function toId(ref: string): string {
	return parseRef(ref)?.id ?? ref;
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
