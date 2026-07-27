// Probes Spotify's Web API changelog for entries we haven't reviewed yet.
//
// Spotify publishes no RSS/sitemap, but changelog URLs are perfectly
// predictable (.../references/changes/<month>-<year>) and 404 when absent,
// so probing the month space is the only reliable way to notice a new entry.
//
// Exits 1 when something unreviewed turns up, so a cron/routine can alert.

import { readFile, writeFile } from "node:fs/promises";

const CHANGELOG_BASE = "https://developer.spotify.com/documentation/web-api/references/changes";
const SEEN_PATH = new URL("./spotify-api-seen.json", import.meta.url);
const FIRST = { year: 2026, month: 2 }; // the February 2026 breaking change

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

/** Every month slug from the first changelog through next month. */
function candidateSlugs(now: Date): string[] {
	const slugs: string[] = [];
	// One month past today: Spotify has published entries mid-month before.
	const end = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 2 };
	let { year, month } = FIRST;
	while (year < end.year || (year === end.year && month <= end.month)) {
		const name = MONTHS[month - 1];
		if (name) slugs.push(`${name}-${year}`);
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return slugs;
}

async function exists(slug: string): Promise<boolean> {
	const response = await fetch(`${CHANGELOG_BASE}/${slug}`, { redirect: "follow" });
	return response.ok;
}

const seen: string[] = JSON.parse(await readFile(SEEN_PATH, "utf8"));
const slugs = candidateSlugs(new Date());

const found: string[] = [];
for (const slug of slugs) {
	if (await exists(slug)) found.push(slug);
}

const unreviewed = found.filter((slug) => !seen.includes(slug));
const vanished = seen.filter((slug) => !found.includes(slug));

for (const slug of found) {
	console.log(`${unreviewed.includes(slug) ? "NEW " : "    "}${CHANGELOG_BASE}/${slug}`);
}
if (vanished.length > 0) {
	console.log(`\nreviewed but no longer reachable: ${vanished.join(", ")}`);
}

if (process.argv.includes("--accept") && unreviewed.length > 0) {
	// Single-line with spaces after commas, so --accept output stays Biome-clean.
	await writeFile(SEEN_PATH, `${JSON.stringify(found).replaceAll('","', '", "')}\n`);
	console.log(`\naccepted ${unreviewed.length} entry(s) into the reviewed set`);
	process.exit(0);
}

if (unreviewed.length > 0) {
	console.log(
		`\n${unreviewed.length} unreviewed changelog entry(s) — read them, then re-run with --accept`,
	);
	process.exit(1);
}
console.log("\nno unreviewed changelog entries");
