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
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export function fakeSpotify(routes: Record<string, (seen: SeenRequest) => Response>) {
	const seen: SeenRequest[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		const bodyText = await req.text();
		const record: SeenRequest = {
			method: req.method,
			path: url.pathname,
			query: url.searchParams,
			// Not every body is JSON — the cover upload posts base64 under image/jpeg.
			body: bodyText ? parseBody(bodyText) : undefined,
			contentType: req.headers.get("Content-Type"),
			token: req.headers.get("Authorization")?.replace("Bearer ", "") ?? null,
		};
		seen.push(record);
		const route = routes[`${req.method} ${url.pathname}`];
		return (
			route?.(record) ??
			Response.json({ error: { status: 404, message: "Service not found" } }, { status: 404 })
		);
	}) as typeof fetch;
	return { seen, fetchImpl };
}

export function staticTokens(): TokenProvider {
	return {
		getAccessToken: async () => "tok",
		refreshAccessToken: async () => "tok2",
	};
}
