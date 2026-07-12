# AGENTS.md

Guidance for AI agents working on **siftly**. Humans: see `README.md` and `CONTRIBUTING.md`.

## What this is

A local, personal CLI + MCP server that pulls agent-ready content from Hacker News,
YouTube (transcripts), X/Twitter (trends, search, curated news, user timelines), and
RSS/Atom feeds, plus a multi-source `digest`. Runs on **Bun** (TypeScript, no build step).

## The one rule that defines siftly

**siftly does NOT summarize.** It extracts and normalizes; the *consuming agent* summarizes.
Do not add an LLM/summarization dependency to the core. The single deliberate exception is
YouTube's optional `--gemini` transcription fallback for caption-less videos.

## Commands

```bash
bun run src/cli.ts <hn|yt|x|rss|digest|cache> [options]   # run the CLI
bun run typecheck                                          # tsc --noEmit — must be clean
bun test                                                   # offline fixture tests — must pass
bun run src/cli.ts mcp                                    # the MCP server (stdio)
```

Always run `bun run typecheck` and `bun test` before committing.

## Architecture

- Everything converges on the `Item` schema (`src/types.ts`) and renders through
  `src/render/markdown.ts` (`renderMarkdown`, `renderDigest`).
- Sources live in `src/sources/*.ts`. Each **separates pure parsing/normalization from
  network I/O** (e.g. `parseFeed` vs `fetchFeed`, `parseNewsStory` vs `fetchNewsStory`).
- `src/store/cache.ts` — `cached()` over `bun:sqlite` at `~/.siftly/siftly.db`.
- `src/digest.ts` — orchestrates sources into sections; dedupes across them by url.
- `src/cli.ts` — arg parsing + dispatch. `src/mcp.ts` — MCP tools over the same core.
- `src/config.ts` — optional `~/.siftly/config.json` defaults (flag > config > built-in).

## Conventions

- **Fixture-only tests** — no network in `test/`. Test pure functions; verify network/
  yt-dlp/cache live.
- **Reuse** `cached()`, `renderMarkdown`, `htmlToText` (`src/util/html.ts`). Reuse the same
  cache-key format across CLI and MCP so they share the cache.
- **No premature abstraction** — there is deliberately no formal `Source` interface; each
  source exports its own functions and the dispatchers call them.
- TypeScript strict; match the surrounding style.

## Adding a source

1. `src/sources/<name>.ts` — pure parse/normalize + a `fetch*` returning `Item[]`.
2. Wire a command into `src/cli.ts` (and, if it fits, a tool into `src/mcp.ts` and a section
   into `src/digest.ts`).
3. Add fixture tests in `test/<name>.test.ts`.
4. Update `README.md`.

## Gotchas

- **MCP stdout is the JSON-RPC channel** — `src/mcp.ts` must never `console.log`. Core
  warnings use `console.error` (stderr), which is safe.
- **Secrets**: `X_BEARER_TOKEN` and `GEMINI_API_KEY` come from `.env` (gitignored; Bun
  auto-loads it). Never commit them.
- **External deps**: `yt-dlp` must be on PATH for the YouTube source; X reads need the
  Basic API tier (Free tier 403s).
- Config, cache DB, `feeds.txt`, and `news.txt` all live under `~/.siftly/` (outside the repo).
