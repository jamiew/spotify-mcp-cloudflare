// Bundle-size guard: reads `wrangler deploy --dry-run` output on stdin and
// fails if the gzipped worker exceeds the budget. Guards against dependency
// bloat from automated edits.
const BUDGET_GZIP_KIB = 600;

let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
});
process.stdin.on("end", () => {
	process.stdout.write(input);
	const match = input.match(/gzip:\s*([\d.]+)\s*KiB/);
	if (!match) {
		console.error("FAIL: could not find gzip size in wrangler output");
		process.exit(1);
	}
	const size = Number(match[1]);
	if (size > BUDGET_GZIP_KIB) {
		console.error(`FAIL: worker bundle ${size} KiB gzipped exceeds budget ${BUDGET_GZIP_KIB} KiB`);
		process.exit(1);
	}
	console.log(`check-size: ${size} KiB gzipped (budget ${BUDGET_GZIP_KIB} KiB) — ok`);
});
