#!/usr/bin/env bash
# Mirrors the GitHub Actions pipeline (.github/workflows/ci.yml) locally.
# Run with `pnpm ci:local` before pushing.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "check: lint"       && pnpm lint
step "check: lint:md"    && pnpm lint:md
step "check: type-check" && pnpm type-check
step "check: meta"       && pnpm check:meta
step "check: test"       && pnpm test

step "security: gitleaks"
if command -v gitleaks >/dev/null; then
	gitleaks git --no-banner .
else
	echo "gitleaks not installed (brew install gitleaks) — SKIPPING secret scan" >&2
fi

step "security: audit"   && pnpm audit --prod --audit-level high

step "size: bundle budget" && pnpm check:size

printf '\n\033[1mall local CI steps passed\033[0m\n'
