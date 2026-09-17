// Meta-lint: keeps code, docs, and the MCP tool surface honest with each other.
// Run with `pnpm check:meta`. Designed as a guardrail for automated/LLM edits:
// - every registered tool and prompt (src/tools.ts) must be mentioned in README.md
// - README's stated tool count must match the code
// - every tool must carry MCP behaviour annotations
// - tool descriptions have a token budget (they're loaded into every client's
//   context window on connect)
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
const agent = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");

const DESCRIPTION_BUDGET_CHARS = 300; // per tool
const TOTAL_BUDGET_CHARS = 5000; // whole tool surface

let failures = 0;
function fail(msg: string) {
	console.error(`FAIL: ${msg}`);
	failures += 1;
}

// One chunk per tool: everything from its name to the start of its handler.
const toolBlocks = [...src.matchAll(/registerTool\(\s*\n?\s*"([a-z_]+)",([\s\S]*?)\n\t+guard\(/g)];
const toolNames = toolBlocks.map((m) => m[1] ?? "");
if (toolNames.length === 0) fail("found no registerTool calls in src/tools.ts (parser broken?)");
const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
if (dupes.length > 0) fail(`duplicate tool registrations: ${dupes.join(", ")}`);

const promptNames = [...src.matchAll(/registerPrompt\(\s*\n?\s*"([a-z_]+)"/g)].map(
	(m) => m[1] ?? "",
);

// Every tool and prompt must be documented in the README
for (const name of [...toolNames, ...promptNames]) {
	if (!readme.includes(`\`${name}\``)) fail(`${name} is not mentioned in README.md`);
}

// Behaviour annotations drive client confirmation prompts, so a tool without
// them silently defaults to "destructive, open world".
// Tools share named annotation constants; resolve one to its definition so
// the checks below see the literal hints.
function resolveAnnotations(block: string): string {
	const named = /annotations:\s*([A-Za-z_]+)\s*,/.exec(block)?.[1];
	if (!named) return block;
	const definition = new RegExp(`const ${named} = \\{([^}]*)\\}`).exec(src)?.[1] ?? "";
	// Spreads pull in another constant's hints; the property after wins.
	const base = /\.\.\.([A-Za-z_]+)/.exec(definition)?.[1];
	const inherited = base ? resolveAnnotations(`annotations: ${base},`) : "";
	return `${inherited} ${definition.replace(/\.\.\.[A-Za-z_]+,?/, "")}`;
}
for (const [i, name] of toolNames.entries()) {
	const block = resolveAnnotations(toolBlocks[i]?.[2] ?? "");
	if (!block.includes("readOnlyHint")) fail(`tool ${name} has no readOnlyHint annotation`);
	if (block.includes("readOnlyHint: false") && !block.includes("destructiveHint")) {
		fail(`writing tool ${name} has no destructiveHint annotation`);
	}
}

// README's stated count must match reality
const countClaim = readme.match(/(\d+) tools\./);
if (!countClaim) {
	fail('README.md no longer states the tool count ("N tools.")');
} else if (Number(countClaim[1]) !== toolNames.length) {
	fail(`README claims ${countClaim[1]} tools but code registers ${toolNames.length}`);
}

// The version clients see must match the package; these drifted once already.
const pkgVersion = /"version":\s*"([^"]+)"/.exec(pkg)?.[1];
const srcVersion = /version:\s*"([^"]+)"/.exec(agent)?.[1];
if (!pkgVersion || !srcVersion) {
	fail("could not read the version from package.json and/or src/index.ts");
} else if (pkgVersion !== srcVersion) {
	fail(`package.json is ${pkgVersion} but the MCP server reports ${srcVersion}`);
}

// Description token budgets
const descriptions = toolBlocks.map(
	(m) => /description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(m[2] ?? "")?.[1] ?? "",
);
if (descriptions.some((d) => d === "")) {
	fail("some tools have no parseable description (parser drift?)");
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
	`check-meta: ${toolNames.length} tools, ${promptNames.length} prompts, ${total} chars of descriptions` +
		(failures ? `, ${failures} failure(s)` : " — all good"),
);
process.exit(failures === 0 ? 0 : 1);
