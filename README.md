# siftly

> Sift the signal from the noise. A personal tool that pulls information from multiple sources and lets you digest the essentials fast, locally.

**siftly** = `sift` (to filter through a sieve) + `-ly` (swiftly / a light, friendly tool). It gathers information from sources like YouTube, X, and Hacker News and hands it back as **clean, agent-ready text** — right on your machine. siftly itself does no summarizing; it extracts and normalizes content so the coding agent you already use (Claude Code, Codex, …) can produce the summary and read the comment sentiment in seconds.

## Why?

Information sources are fragmented, and opening each one to read costs time. siftly brings that into one place.

- **Hacker News** — today's top stories with their comment trees, ready to summarize _(implemented)_
- **YouTube** — pull a video's transcript/captions from a URL
- **X (Twitter)** — via the paid API: the trending page plus a few posts from relevant well-known accounts
- **RSS / newsletters** — any RSS/Atom feed (blogs, Substack, …), merged newest-first
- **Later** — Reddit and more as plugins

Designed as a personal tool first, with an eye toward growing into a service if it proves useful.

## Core Concept

Every source follows the same pipeline:

```
fetch → normalize → store / display
```

Summarization is intentionally **not** part of the pipeline. siftly outputs content in a form that a coding agent can read and summarize, so there is no built-in LLM, no API key, and no per-summary cost. Because of this shared structure, adding a new source only means implementing an adapter — the rest of the pipeline is reused as-is.

### Normalized Schema

Every source converges on a common `Item` format:

```
Item {
  id
  source        // youtube | x | hackernews | ...
  title
  author
  timestamp
  body          // article / transcript / thread text
  comments[]    // comments & replies (for reading sentiment)
  metadata      // source-specific extras (views, score, url, ...)
}
```

### Summary Output

siftly doesn't generate this — the consuming agent does, from the extracted content. Each render ends with a hint asking the agent for a structured result regardless of source:

- **3-line gist** — the essentials only
- **Key points** — what it's about
- **Sentiment** — the overall mood of the comments/reactions

## Architecture Principles

- **Source adapter abstraction** — each source implements the same `fetch → normalize` shape, converging on the common `Item`. This is the heart of extensibility. (The formal interface is extracted once a second source exists — not before, to avoid guessing wrong.)
- **No built-in LLM** — siftly extracts and renders; the coding agent that consumes the output does the summarizing. No provider SDK, key, or cost inside the tool.
- **Local-first** — cache fetched results locally in SQLite for fast re-reads. Keep the storage layer abstracted so it can be swapped when moving to a service.
- **CLI-first, service-ready** — keep core logic as a library and the CLI as a thin wrapper, so a web service can later call the same core.

## Roadmap

- [x] **Phase 1 — Vertical slice (Hacker News)**
  Whole pipeline end-to-end via the free Algolia HN API — front-page fetch, comment tree, SQLite cache, agent-ready markdown. No auth, no cost.
- [x] **Phase 2 — YouTube transcript fetching**
  Transcript + metadata via `yt-dlp` (the official Data API can't return third-party captions, and the unofficial endpoint is po_token-gated). Manual/auto caption selection, optional `[mm:ss]` timestamps.
- [x] **Phase 3 — X ingestion**
  Via the X API v2 (App-only Bearer, read-only). Trending digest + the most-engaged recent posts per trend, or a free-form topic search. Also YouTube's `--gemini` fallback for caption-less videos (Gemini REST, no SDK).
- [x] **Phase 4 — RSS / newsletters**
  RSS/Atom feeds from `~/.siftly/feeds.txt` (or a single URL), merged newest-first, with `--since` filtering. Newsletters that expose a feed (Substack `/feed`, …) come through the same path. Free, no auth.
- [ ] **Phase 5 — Local web UI + thread expansion**
  Follow a single topic across multiple sources.
- [ ] **Phase 6 — Service**
  Multi-user, auth, and billing considerations.

## Source Constraints (reference)

| Source | Access | Difficulty |
|--------|--------|------------|
| Hacker News | Algolia HN API (free, no auth) | Low |
| RSS / newsletters | Any RSS/Atom feed (free, no auth) | Low |
| YouTube | `yt-dlp` captions, `--gemini` fallback (Gemini key) | Medium |
| X (Twitter) | X API v2 Bearer — reads need Basic tier (~$200/mo) | High |

## Getting Started

Requires [Bun](https://bun.sh) (TypeScript runs directly — no build step). The only npm dependency is `fast-xml-parser` (feed parsing); everything else uses native `fetch`, `bun:sqlite`, and `util.parseArgs`. Per-source setup:

- **Hacker News** — nothing; free API.
- **RSS** — list feed URLs in `~/.siftly/feeds.txt` (one per line, `#` comments), or pass one on the command line.
- **YouTube** — [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your PATH (`brew install yt-dlp`). For the `--gemini` fallback, set `GEMINI_API_KEY`.
- **X** — set `X_BEARER_TOKEN` (App-only Bearer). Reads need the Basic tier or higher; Free tier returns 403.

Put keys in a `.env` file (Bun auto-loads it; it's gitignored):

```bash
GEMINI_API_KEY=...
X_BEARER_TOKEN=...
```

```bash
bun install

# Digest — several sources at once, one document (the "morning one-shot")
bun run src/cli.ts digest                        # HN + RSS, ready to paste into an agent
bun run src/cli.ts digest --sources hn,rss,x     # add X (needs X_BEARER_TOKEN)
bun run src/cli.ts digest --since 24h --limit 8

# Hacker News — today's front page → agent-ready markdown on stdout
bun run src/cli.ts hn
bun run src/cli.ts hn --limit 5 --comments 20   # more stories / comments
bun run src/cli.ts hn <story_id>                # one story, deep

# YouTube — a video's transcript (needs yt-dlp)
bun run src/cli.ts yt "https://youtu.be/VIDEO_ID"
bun run src/cli.ts yt VIDEO_ID --timestamps     # prefix lines with [mm:ss]
bun run src/cli.ts yt VIDEO_ID --gemini         # transcribe if no captions

# X — trending digest / topic search (needs X_BEARER_TOKEN)
bun run src/cli.ts x                             # trending + top posts per trend
bun run src/cli.ts x --query "OpenAI" --posts 5 # top recent posts on a topic
bun run src/cli.ts x --woeid 23424868           # trends for a location (KR)

# RSS — feeds from ~/.siftly/feeds.txt, or a single feed
bun run src/cli.ts rss                           # all feeds, merged newest-first
bun run src/cli.ts rss --since 24h --limit 10    # only the last day
bun run src/cli.ts rss "https://simonwillison.net/atom/everything/"

# Shared options
bun run src/cli.ts hn --json                    # normalized Items as JSON
bun run src/cli.ts hn --out today.md            # write to a file
bun run src/cli.ts hn --refresh                 # bypass the 30-min cache
```

Then paste the output into your coding agent (or have it run the command) and ask for a gist. Install globally with `bun link` to use `siftly` directly.

> **X note:** the v2 recent-search API only covers the last ~7 days and can't sort by popularity on Basic tier, so siftly over-fetches and ranks by engagement client-side. For very active trends the top posts may still be low-engagement (seconds old) — `--query` gives better signal for a specific topic.

Fetched results are cached in SQLite at `~/.siftly/siftly.db`, so re-runs are near-instant.

## Project Structure

```
src/
  cli.ts              # entry point + arg parsing (util.parseArgs)
  digest.ts           # multi-source orchestrator (siftly digest)
  types.ts            # normalized Item / Comment
  sources/
    hackernews.ts     # Algolia HN API: fetch + normalize
    youtube.ts        # yt-dlp captions + Gemini fallback → normalize
    x.ts              # X API v2: trends + search → normalize
    rss.ts            # RSS/Atom feeds (fast-xml-parser) → normalize
  store/
    cache.ts          # bun:sqlite fetch cache (TTL)
  render/
    markdown.ts       # Item[] → agent-ready markdown
  util/
    html.ts           # HN comment HTML → plain text
    youtube-url.ts    # YouTube URL / id parsing
test/
  hackernews.test.ts  # fixture-based unit tests (no network)
  youtube.test.ts     # fixture-based unit tests (no network)
  x.test.ts           # fixture-based unit tests (no network)
  rss.test.ts         # fixture-based unit tests (no network)
  digest.test.ts      # fixture-based unit tests (no network)
```

Run `bun test` for the unit tests and `bun run typecheck` for types.

## License

TBD