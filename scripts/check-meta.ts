// Meta-lint: keeps docs and the MCP tool surface honest with each other.
// Run with `pnpm check:meta`. It lists the real surface through an in-process
// MCP client, so it sees exactly what a client sees:
// - every tool and prompt must be mentioned in README.md
// - tool descriptions have a size budget (they're loaded into every client's
//   context window on connect)
// src/local/mcp-json.test.ts enforces behavior annotations on the running server.
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSpotifyServer } from "../src/server";

const DESCRIPTION_BUDGET_CHARS = 300; // per tool
const TOTAL_BUDGET_CHARS = 5000; // whole tool surface

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// Listing never calls Spotify, so the client factory is never invoked.
const server = createSpotifyServer(() => {
	throw new Error("check-meta never calls a tool");
});
const client = new Client({ name: "check-meta", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
await client.close();
await server.close();

let failures = 0;
function fail(msg: string) {
	console.error(`FAIL: ${msg}`);
	failures += 1;
}

if (tools.length === 0) fail("the server lists no tools");

for (const { name } of [...tools, ...prompts]) {
	if (!readme.includes(`\`${name}\``)) fail(`${name} is not mentioned in README.md`);
}

let total = 0;
for (const { name, description = "" } of tools) {
	if (description === "") fail(`${name} has no description`);
	if (description.length > DESCRIPTION_BUDGET_CHARS) {
		fail(`${name} description is ${description.length} chars, over ${DESCRIPTION_BUDGET_CHARS}`);
	}
	total += description.length;
}
if (total > TOTAL_BUDGET_CHARS) {
	fail(`total description size ${total} chars exceeds budget ${TOTAL_BUDGET_CHARS}`);
}

console.log(
	`check-meta: ${tools.length} tools, ${prompts.length} prompts, ${total} chars of descriptions` +
		(failures ? `, ${failures} failure(s)` : ", all good"),
);
process.exit(failures === 0 ? 0 : 1);
