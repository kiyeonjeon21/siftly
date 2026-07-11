# Contributing to siftly

siftly is a personal-first tool, but contributions are welcome. This doc covers
setup and the conventions that keep the codebase coherent.

## Setup

- Install [Bun](https://bun.sh), then `bun install`.
- For the **YouTube** source, install `yt-dlp` (`brew install yt-dlp`).
- For **X** and the YouTube **`--gemini`** fallback, put keys in `.env` (gitignored):

  ```
  X_BEARER_TOKEN=...
  GEMINI_API_KEY=...
  ```

## Develop

```bash
bun run src/cli.ts <hn|yt|x|rss|digest> [options]   # run a command
bun run typecheck                                    # tsc --noEmit
bun test                                             # fixture-based unit tests
bun run src/mcp.ts                                   # the MCP server (stdio)
```

The MCP server is easiest to poke at with the inspector:
`bunx @modelcontextprotocol/inspector bun run src/mcp.ts`.

## Conventions (what keeps siftly siftly)

- **No built-in LLM.** siftly extracts and normalizes; the consuming agent
  summarizes. Don't add a summarization/LLM dependency to the core — the one
  deliberate exception is YouTube's optional `--gemini` transcription fallback.
- **Everything converges on the `Item` schema** (`src/types.ts`) and renders
  through `src/render/markdown.ts` (`renderMarkdown` / `renderDigest`).
- **Separate pure parsing from network I/O** in each source (e.g. `parseFeed`
  vs `fetchFeed`, `parseNewsStory` vs `fetchNewsStory`) so parsing and
  normalization can be unit-tested with fixtures.
- **Tests are fixture-based and offline** — no network calls in `test/`.
- **Cache** fetches through `cached()` (`src/store/cache.ts`); reuse the same
  cache-key format the CLI uses so the CLI and MCP server share the cache.
- **Avoid premature abstraction** — there is deliberately no formal `Source`
  interface. Each source exports its own functions; the CLI and MCP server
  dispatch. Extract a shared shape only when the duplication is real.
- TypeScript strict; match the surrounding style.

## Adding a source

1. `src/sources/<name>.ts` — pure parse/normalize + a `fetch*` returning `Item[]`.
2. Wire a command into `src/cli.ts` (and, if it fits, a tool into `src/mcp.ts`
   and a section into `src/digest.ts`).
3. Add fixture tests in `test/<name>.test.ts` (no network).
4. Update the README.

## Pull requests

Keep them focused. Run `bun run typecheck` + `bun test`, exercise the change
live, and fill in the PR template.
