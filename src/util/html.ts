/**
 * Convert the small HTML subset Hacker News uses in comment/story text into
 * plain text. HN only emits <p>, <a href>, <i>, <pre><code>, and a handful of
 * named/numeric entities, so a full HTML parser would be overkill.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Strip HN's HTML to readable plain text, keeping link URLs and paragraph
 * breaks so the output stays useful for an agent to summarize.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";

  let text = html;

  // <p> starts a new paragraph.
  text = text.replace(/<p>/gi, "\n\n");

  // Preserve the href of links as "text (url)".
  text = text.replace(
    /<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
    (_whole, href: string, label: string) =>
      label && label !== href ? `${label} (${href})` : href,
  );

  // Drop any remaining tags (<i>, <pre>, <code>, stray closers, ...).
  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  // Collapse excess blank lines and trailing whitespace.
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
