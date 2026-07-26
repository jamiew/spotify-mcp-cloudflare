// Meta-lint: keeps code, docs, and the MCP tool surface honest with each other.
// Run with `pnpm check:meta`. Designed as a guardrail for automated/LLM edits:
// - every registered tool must be mentioned in README.md
// - README's stated tool count must match the code
// - tool descriptions have a token budget (they're loaded into every client's
//   context window on connect)
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const DESCRIPTION_BUDGET_CHARS = 300; // per tool
const TOTAL_BUDGET_CHARS = 5000; // whole tool surface

let failures = 0;
function fail(msg: string) {
	console.error(`FAIL: ${msg}`);
	failures += 1;
}

// Tool registrations: this.server.registerTool("name", ...)
const toolNames = [...src.matchAll(/registerTool\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
if (toolNames.length === 0) fail("found no registerTool calls in src/index.ts (parser broken?)");
const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
if (dupes.length > 0) fail(`duplicate tool registrations: ${dupes.join(", ")}`);

// Every tool must be documented in the README
for (const name of toolNames) {
	if (!readme.includes(`\`${name}\``)) fail(`tool ${name} is not mentioned in README.md`);
}

// README's stated count must match reality
const countClaim = readme.match(/(\d+) tools\./);
if (!countClaim) {
	fail('README.md no longer states the tool count ("N tools.")');
} else if (Number(countClaim[1]) !== toolNames.length) {
	fail(`README claims ${countClaim[1]} tools but code registers ${toolNames.length}`);
}

// Description token budgets
const descriptions = [...src.matchAll(/description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map(
	(m) => m[1] ?? "",
);
if (descriptions.length < toolNames.length) {
	fail(
		`found ${descriptions.length} description strings for ${toolNames.length} tools (parser drift?)`,
	);
}
for (const d of descriptions) {
	if (d.length > DESCRIPTION_BUDGET_CHARS) {
		fail(`description over ${DESCRIPTION_BUDGET_CHARS} chars: "${d.slice(0, 60)}..."`);
	}
}
const total = descriptions.reduce((sum, d) => sum + d.length, 0);
if (total > TOTAL_BUDGET_CHARS) {
	fail(`total description size ${total} chars exceeds budget ${TOTAL_BUDGET_CHARS}`);
}

console.log(
	`check-meta: ${toolNames.length} tools, ${total} chars of descriptions` +
		(failures ? `, ${failures} failure(s)` : " — all good"),
);
process.exit(failures === 0 ? 0 : 1);
