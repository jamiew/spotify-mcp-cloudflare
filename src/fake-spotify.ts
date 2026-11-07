// Test-only fake Spotify upstream: routes keyed by "METHOD /path", every
// request recorded. Not imported by worker code.
import type { TokenProvider } from "./spotify";

export interface SeenRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
	contentType: string | null;
	token: string | null;
	signal: AbortSignal | undefined;
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Routes may answer late, or never. Like real fetch, an aborted signal rejects
 * the pending answer.
 */
export function fakeSpotify(
	routes: Record<string, (seen: SeenRequest) => Response | Promise<Response>>,
) {
	const seen: SeenRequest[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		const bodyText = await req.text();
		const signal = init?.signal ?? undefined;
		const record: SeenRequest = {
			method: req.method,
			path: url.pathname,
			query: url.searchParams,
			// Not every body is JSON: the cover upload posts base64 under image/jpeg.
			body: bodyText ? parseBody(bodyText) : undefined,
			contentType: req.headers.get("Content-Type"),
			token: req.headers.get("Authorization")?.replace("Bearer ", "") ?? null,
			signal,
		};
		seen.push(record);
		const route = routes[`${req.method} ${url.pathname}`];
		const answer = Promise.resolve(
			route?.(record) ??
				Response.json({ error: { status: 404, message: "Service not found" } }, { status: 404 }),
		);
		if (!signal) return answer;
		signal.throwIfAborted();
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([answer, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};
	return { seen, fetchImpl };
}

export function staticTokens(): TokenProvider {
	return {
		getAccessToken: async () => "tok",
		refreshAccessToken: async () => "tok2",
	};
}
