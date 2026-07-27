// Minimal landing page served at "/" with connect instructions.
export function landingPage(origin: string): string {
	const mcpUrl = `${origin}/mcp`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spotify-mcp-cloudflare</title>
<style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 42rem;
              margin: 3rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; background: #fafafa; }
      @media (prefers-color-scheme: dark) { body { color: #e5e5e5; background: #121212; } }
      h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
      code, pre { background: rgba(125,125,125,.15); border-radius: 4px; padding: .1em .35em; }
      pre { padding: .75em 1em; overflow-x: auto; }
      a { color: #1db954; }
      .beta { display: inline-block; background: #1db954; color: #000; border-radius: 4px;
              padding: 0 .4em; font-size: .8em; vertical-align: middle; }
</style>
</head>
<body>
<h1>spotify-mcp-cloudflare <span class="beta">beta</span></h1>
<p>A remote <a href="https://modelcontextprotocol.io">MCP</a> server for Spotify:
search, playlists, library, queue and playback as 24 token-efficient tools.
Auth is standard MCP OAuth &mdash; connecting opens Spotify's consent screen, no keys to copy.</p>

<h2>Connect from Claude Code</h2>
<pre>claude mcp add --transport http spotify ${mcpUrl}</pre>
<p>Then <code>/mcp</code> &rarr; spotify &rarr; Authenticate.</p>

<h2>Connect from claude.ai / Claude Desktop</h2>
<p>Settings &rarr; Connectors &rarr; Add custom connector &rarr; <code>${mcpUrl}</code></p>

<h2>Endpoints</h2>
<p><code>/mcp</code> Streamable HTTP &middot; <code>/sse</code> legacy SSE &middot;
<code>/.well-known/oauth-authorization-server</code> discovery</p>

<h2>Heads up</h2>
<p>This instance's Spotify API key is registered to
<a href="https://github.com/jamiew">@jamiew</a>; Spotify Development Mode caps it at
~5 allowlisted users. Want your own? It's one <code>wrangler deploy</code> &mdash;
<a href="https://github.com/jamiew/spotify-mcp-cloudflare">source &amp; instructions on GitHub</a>.</p>
<p>Spotify breaks its Web API on short notice and publishes no feed for it, so the repo
ships a <code>/spotify-api-watch</code> agent skill that sweeps the changelog and probes
this server for silent breakage &mdash; run it weekly to get alerted instead of surprised.</p>
</body>
</html>`;
}
