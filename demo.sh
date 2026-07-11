#!/usr/bin/env bash
#
# siftly demo — a short, recordable tour of the CLI.
#
# Prereqs (run from the repo root): bun; yt-dlp for the YouTube bit;
# X_BEARER_TOKEN in .env for the X bits. Missing pieces just print an error and
# the tour continues.
#
# Record it:
#   asciinema rec siftly.cast -c ./demo.sh   # then: agg siftly.cast docs/demo.gif
# Or screen-record your terminal while it runs.
#
# Knobs: SIFTLY="siftly" (if globally linked), DEMO_PAUSE=3 (seconds between steps).

set -u
SIFTLY="${SIFTLY:-bun run src/cli.ts}"
PAUSE="${DEMO_PAUSE:-2}"

say() { printf '\n\033[1;35m# %s\033[0m\n' "$*"; sleep 1; }
run() { printf '\033[1;32m$ %s\033[0m\n' "$*"; eval "$*"; sleep "$PAUSE"; }

say "siftly pulls HN / YouTube / X / RSS into agent-ready text."
say "It doesn't summarize — your coding agent does. Here's what it extracts:"

say "Curated X news on a topic (Grok-summarized stories + the posts behind them)"
run "$SIFTLY x --news 'AI' --posts 2"

say "A YouTube channel's recent videos — list first, then pull any transcript"
run "$SIFTLY yt --channel @aiDotEngineer --list --limit 4"

say "A specific account's recent posts"
run "$SIFTLY x --user OpenAI --posts 3"

say "Everything at once → one document (the 'morning briefing')"
run "$SIFTLY digest --limit 2"

say "A local cache you control"
run "$SIFTLY cache stats"

say "Best part: it's also an MCP server. In Claude Desktop/Code just ask"
say "\"what's on Hacker News today?\" and siftly gets called for you."
