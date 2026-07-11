/**
 * Extract a YouTube video id from the many forms a user might paste, or accept
 * a bare 11-char id. Returns null when nothing looks like a video id.
 */

const BARE_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (BARE_ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id && BARE_ID.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    // watch?v=<id>
    const v = url.searchParams.get("v");
    if (v && BARE_ID.test(v)) return v;

    // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1] ?? null;
  }

  return null;
}

/** Canonical watch URL for a video id. */
export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
