/**
 * YouTube source, backed by the `yt-dlp` CLI (external binary).
 *
 * The official Data API can't return third-party captions, and the unofficial
 * timedtext endpoint is po_token-gated (returns empty bodies). yt-dlp handles
 * all of that, so siftly shells out to it: one call for metadata, one to
 * download the chosen caption track as json3.
 *
 * Pure parsing/normalization (`parseJson3`, `pickLang`, `normalizeVideo`) is
 * separated from the shell calls so it can be unit-tested against fixtures.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Item, TranscriptSegment } from "../types.ts";
import { parseVideoId, watchUrl } from "../util/youtube-url.ts";

export class NoCaptionsError extends Error {
  constructor(readonly videoId: string) {
    super(`No captions available for video ${videoId}.`);
    this.name = "NoCaptionsError";
  }
}

// ---- yt-dlp metadata shape (only fields we use) ----

export interface YtMeta {
  id: string;
  title: string | null;
  uploader?: string | null;
  channel?: string | null;
  view_count?: number | null;
  duration?: number | null;
  upload_date?: string | null; // YYYYMMDD
  language?: string | null;
  webpage_url?: string | null;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

// ---- Pure helpers ----

/** Parse a json3 caption file into ordered transcript segments. */
export function parseJson3(text: string): TranscriptSegment[] {
  const data = JSON.parse(text) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  const segments: TranscriptSegment[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs) continue;
    const t = (ev.segs.map((s) => s.utf8 ?? "").join("")).replace(/\s+/g, " ").trim();
    if (!t) continue;
    segments.push({ offsetMs: ev.tStartMs ?? 0, text: t });
  }
  return segments;
}

/** Join segments into one flowing plain-text body. */
export function buildBody(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** YYYYMMDD -> unix epoch seconds (0 if unparseable). */
function uploadDateToEpoch(d: string | null | undefined): number {
  if (!d || !/^\d{8}$/.test(d)) return 0;
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

/**
 * Choose a single caption language code to download. Prefers manual captions
 * (English, then the video's language), falls back to auto-generated, avoiding
 * machine-translated variants (codes containing "-") unless nothing else fits.
 */
export function pickLang(
  meta: YtMeta,
): { lang: string; auto: boolean } | null {
  const manual = Object.keys(meta.subtitles ?? {}).filter((l) => l !== "live_chat");
  const auto = Object.keys(meta.automatic_captions ?? {});
  const prefs = ["en", meta.language].filter((x): x is string => !!x);

  for (const p of prefs) if (manual.includes(p)) return { lang: p, auto: false };
  if (manual.length) return { lang: manual[0]!, auto: false };

  for (const p of prefs) if (auto.includes(p)) return { lang: p, auto: true };
  const untranslated = auto.filter((l) => !l.includes("-"));
  if (untranslated.length) return { lang: untranslated[0]!, auto: true };
  if (auto.length) return { lang: auto[0]!, auto: true };

  return null;
}

/** Map yt-dlp metadata + parsed segments into a normalized Item. */
export function normalizeVideo(
  meta: YtMeta,
  segments: TranscriptSegment[],
  lang: { lang: string; auto: boolean },
): Item {
  return {
    id: meta.id,
    source: "youtube",
    title: meta.title ?? "(untitled)",
    author: meta.uploader ?? meta.channel ?? "",
    timestamp: uploadDateToEpoch(meta.upload_date),
    body: buildBody(segments),
    comments: [],
    metadata: {
      url: meta.webpage_url ?? watchUrl(meta.id),
      views: meta.view_count ?? undefined,
      durationSec: meta.duration ?? undefined,
      transcript: segments,
      transcriptLang: lang.lang,
      transcriptAuto: lang.auto,
    },
  };
}

// ---- Shell (yt-dlp) ----

async function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  // IIFE keeps the { stdout: "pipe" } narrowing (an explicit annotation would widen it).
  const proc = (() => {
    try {
      return Bun.spawn(["yt-dlp", ...args], { stdout: "pipe", stderr: "pipe" });
    } catch {
      throw new Error("yt-dlp not found. Install it with: brew install yt-dlp");
    }
  })();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function fetchMeta(url: string): Promise<YtMeta> {
  const { stdout, stderr, code } = await runYtDlp(["-J", "--skip-download", "--no-warnings", url]);
  if (code !== 0 || !stdout.trim()) {
    throw new Error(`yt-dlp could not read the video: ${stderr.trim().split("\n").pop() ?? "unknown error"}`);
  }
  return JSON.parse(stdout) as YtMeta;
}

async function fetchSegments(url: string, lang: string): Promise<TranscriptSegment[]> {
  const dir = mkdtempSync(join(tmpdir(), "siftly-yt-"));
  try {
    const { stderr, code } = await runYtDlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      lang,
      "--sub-format",
      "json3",
      "-o",
      join(dir, "%(id)s.%(ext)s"),
      "--no-warnings",
      url,
    ]);
    const file = readdirSync(dir).find((f) => f.endsWith(".json3"));
    if (!file) {
      throw new Error(
        `yt-dlp wrote no captions${code !== 0 ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
      );
    }
    return parseJson3(readFileSync(join(dir, file), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Gemini fallback (transcribes when no captions exist) ----

const GEMINI_MODEL = "gemini-2.5-flash";
const TRANSCRIBE_PROMPT =
  "Transcribe this video verbatim. Output ONLY the transcript text, with no commentary, timestamps, or speaker labels.";

/** Ask Gemini to transcribe a YouTube URL via the REST API (no SDK). */
async function geminiTranscribe(url: string): Promise<string> {
  const key = Bun.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set (needed for --gemini).");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ file_data: { file_uri: url } }, { text: TRANSCRIBE_PROMPT }] }],
      }),
    },
  );
  const json = (await res.json()) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${json.error?.message ?? "unknown error"}`);
  }
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty transcript.");
  return text;
}

/** Build an Item from yt-dlp metadata + a Gemini-generated transcript. */
function normalizeGeminiVideo(meta: YtMeta, transcript: string): Item {
  return {
    id: meta.id,
    source: "youtube",
    title: meta.title ?? "(untitled)",
    author: meta.uploader ?? meta.channel ?? "",
    timestamp: uploadDateToEpoch(meta.upload_date),
    body: transcript,
    comments: [],
    metadata: {
      url: meta.webpage_url ?? watchUrl(meta.id),
      views: meta.view_count ?? undefined,
      durationSec: meta.duration ?? undefined,
      generatedBy: "gemini",
    },
  };
}

export interface FetchVideoOptions {
  /** Fall back to Gemini transcription when the video has no captions. */
  gemini?: boolean;
}

/** Fetch a video's transcript + metadata as a normalized Item. */
export async function fetchVideo(input: string, opts: FetchVideoOptions = {}): Promise<Item> {
  const id = parseVideoId(input);
  if (!id) throw new Error(`Not a recognizable YouTube URL or video id: "${input}"`);
  const url = watchUrl(id);

  // Metadata comes from yt-dlp regardless of caption availability.
  const meta = await fetchMeta(url);
  const lang = pickLang(meta);
  const segments = lang ? await fetchSegments(url, lang.lang) : [];

  if (lang && segments.length) return normalizeVideo(meta, segments, lang);

  // No captions: use Gemini if allowed, else signal the caller.
  if (opts.gemini) return normalizeGeminiVideo(meta, await geminiTranscribe(url));
  throw new NoCaptionsError(id);
}

// ---- Channel (recent videos of a channel/handle) ----

/** Build a channel /videos URL from a handle, bare name, or full URL. */
function channelUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//.test(s)) return s;
  const handle = s.startsWith("@") ? s : `@${s}`;
  return `https://www.youtube.com/${handle}/videos`;
}

/** Parse yt-dlp `%(id)s\t%(title)s` lines into {id, title}. */
export function parseChannelListing(stdout: string): { id: string; title: string }[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab === -1
        ? { id: line, title: "" }
        : { id: line.slice(0, tab), title: line.slice(tab + 1) };
    })
    .filter((v) => v.id);
}

/** List a channel's most recent videos (fast, no transcript download). */
export async function listChannelVideos(
  input: string,
  limit: number,
): Promise<{ id: string; title: string }[]> {
  const { stdout, stderr, code } = await runYtDlp([
    "--flat-playlist",
    "--playlist-end",
    String(limit),
    "--print",
    "%(id)s\t%(title)s",
    "--no-warnings",
    channelUrl(input),
  ]);
  const vids = parseChannelListing(stdout);
  if (!vids.length) {
    throw new Error(
      `no videos found for "${input}"${code !== 0 ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
    );
  }
  return vids;
}

export interface ChannelOptions {
  limit: number;
  gemini?: boolean;
  /** List titles/links only, without fetching transcripts. */
  list?: boolean;
}

/** A channel's recent videos as Items — titles-only, or with transcripts. */
export async function fetchChannel(input: string, opts: ChannelOptions): Promise<Item[]> {
  const vids = await listChannelVideos(input, opts.limit);

  if (opts.list) {
    return vids.map((v) => ({
      id: v.id,
      source: "youtube",
      title: v.title || v.id,
      author: "",
      timestamp: 0,
      body: "",
      comments: [],
      metadata: { url: watchUrl(v.id) },
    }));
  }

  // Fetch transcripts concurrently; skip videos that fail (e.g. no captions).
  const items = await Promise.all(
    vids.map((v) =>
      fetchVideo(v.id, { gemini: opts.gemini }).catch((e) => {
        console.error(`siftly: skipping ${v.id} (${e instanceof Error ? e.message : String(e)})`);
        return null;
      }),
    ),
  );
  return items.filter((x): x is Item => x !== null);
}
