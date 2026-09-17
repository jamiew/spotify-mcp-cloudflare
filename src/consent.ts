// The browser half of authorization: CSRF and state binding for the consent
// form, the "remember this client" cookie, and the approval dialog itself.
// Derived from Cloudflare's remote-MCP OAuth reference, trimmed to what we use.

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	toResponse(): Response {
		return Response.json(
			{ error: this.code, error_description: this.description },
			{ status: this.statusCode },
		);
	}
}

const CSRF_COOKIE = "__Host-CSRF_TOKEN";
const STATE_COOKIE = "__Host-CONSENTED_STATE";
const APPROVED_COOKIE = "__Host-APPROVED_CLIENTS";
const TEN_MINUTES = 600;
const THIRTY_DAYS = 30 * 24 * 3600;

function cookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
	const found = (request.headers.get("Cookie") ?? "")
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${name}=`));
	return found ? found.slice(name.length + 1) : null;
}

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// --- CSRF: a token in the form must match one in a short-lived cookie ---

export function generateCSRFProtection(): { token: string; setCookie: string } {
	const token = crypto.randomUUID();
	return { token, setCookie: cookie(CSRF_COOKIE, token, TEN_MINUTES) };
}

export function validateCSRFToken(formData: FormData, request: Request): void {
	const fromForm = formData.get("csrf_token");
	if (typeof fromForm !== "string" || !fromForm) {
		throw new OAuthError("invalid_request", "Missing CSRF token in form data");
	}
	const fromCookie = readCookie(request, CSRF_COOKIE);
	if (!fromCookie) throw new OAuthError("invalid_request", "Missing CSRF token cookie");
	if (fromForm !== fromCookie) throw new OAuthError("invalid_request", "CSRF token mismatch");
}

// --- State: the auth request lives in KV, and its token is bound to the
// browser that consented via a hashed cookie so a stolen callback URL is useless ---

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
): Promise<{ stateToken: string }> {
	const stateToken = crypto.randomUUID();
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: TEN_MINUTES,
	});
	return { stateToken };
}

export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
	return { setCookie: cookie(STATE_COOKIE, await sha256(stateToken), TEN_MINUTES) };
}

export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
	const state = new URL(request.url).searchParams.get("state");
	if (!state) throw new OAuthError("invalid_request", "Missing state parameter");

	const stored = await kv.get(`oauth:state:${state}`);
	if (!stored) throw new OAuthError("invalid_request", "Invalid or expired state");

	const bound = readCookie(request, STATE_COOKIE);
	if (!bound) {
		throw new OAuthError(
			"invalid_request",
			"Missing session binding cookie - authorization flow must be restarted",
		);
	}
	if (bound !== (await sha256(state))) {
		throw new OAuthError(
			"invalid_request",
			"State token does not match session - possible CSRF attack detected",
		);
	}

	let oauthReqInfo: AuthRequest;
	try {
		// Round-tripped through KV by us, so the shape is the one we stored.
		oauthReqInfo = JSON.parse(stored) as AuthRequest;
	} catch {
		throw new OAuthError("server_error", "Invalid state data", 500);
	}
	await kv.delete(`oauth:state:${state}`);
	return { oauthReqInfo, clearCookie: cookie(STATE_COOKIE, "", 0) };
}

// --- Approved clients: an HMAC-signed cookie so a known client skips the dialog ---

async function hmacKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("COOKIE_ENCRYPTION_KEY is required for signing cookies");
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function approvedClients(request: Request, secret: string): Promise<string[]> {
	const value = readCookie(request, APPROVED_COOKIE);
	const [signature, payload] = value?.split(".") ?? [];
	if (!signature || !payload) return [];
	try {
		const data = atob(payload);
		const bytes = Uint8Array.from(signature.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			bytes,
			new TextEncoder().encode(data),
		);
		const parsed: unknown = valid ? JSON.parse(data) : null;
		return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
	} catch {
		return [];
	}
}

export async function isClientApproved(
	request: Request,
	clientId: string,
	secret: string,
): Promise<boolean> {
	return (await approvedClients(request, secret)).includes(clientId);
}

export async function addApprovedClient(
	request: Request,
	clientId: string,
	secret: string,
): Promise<string> {
	const payload = JSON.stringify([
		...new Set([...(await approvedClients(request, secret)), clientId]),
	]);
	const signature = hex(
		await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)),
	);
	return cookie(APPROVED_COOKIE, `${signature}.${btoa(payload)}`, THIRTY_DAYS);
}

// --- Approval dialog ---

const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

/** Only http(s) URLs are rendered as links; anything else becomes empty. */
function safeUrl(url: string | undefined): string {
	if (!url) return "";
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? escapeHtml(url.trim())
			: "";
	} catch {
		return "";
	}
}

export interface ApprovalDialogOptions {
	client: ClientInfo | null;
	server: { name: string; logo?: string; description?: string };
	state: { oauthReqInfo: AuthRequest };
	csrfToken: string;
	setCookie: string;
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, server, state, csrfToken, setCookie } = options;
	const clientName = client?.clientName ? escapeHtml(client.clientName) : "Unknown MCP Client";
	const rows: [string, string][] = [
		["Name", clientName],
		["Website", link(safeUrl(client?.clientUri))],
		["Privacy policy", link(safeUrl(client?.policyUri))],
		["Terms of service", link(safeUrl(client?.tosUri))],
		["Redirect URIs", (client?.redirectUris ?? []).map(safeUrl).filter(Boolean).join("<br>")],
		["Contact", escapeHtml(client?.contacts?.join(", ") ?? "")],
	];
	const logo = safeUrl(server.logo);

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${clientName} | Authorization Request</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 32rem;
         margin: 3rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e5e5e5; background: #121212; } }
  h1 { font-size: 1.3rem; } h1 img { vertical-align: -6px; margin-right: .4rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; word-break: break-all; }
  dt { opacity: .7; } a { color: #1db954; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: 6px; border: 0;
           background: #1db954; color: #000; cursor: pointer; margin-right: 1rem; }
</style>
</head>
<body>
<h1>${logo ? `<img src="${logo}" alt="" width="28" height="28">` : ""}${escapeHtml(server.name)}</h1>
${server.description ? `<p>${escapeHtml(server.description)}</p>` : ""}
<p><strong>${clientName}</strong> is requesting access to your Spotify account through this server.</p>
<dl>${rows
		.filter(([, value]) => value)
		.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
		.join("")}</dl>
<form method="post" action="${new URL(request.url).pathname}">
  <input type="hidden" name="state" value="${btoa(JSON.stringify(state))}">
  <input type="hidden" name="csrf_token" value="${csrfToken}">
  <button type="submit">Approve</button>
  <a href="/">Cancel</a>
</form>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src *",
		},
	});
}

const link = (url: string) =>
	url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` : "";
