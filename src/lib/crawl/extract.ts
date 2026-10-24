import "server-only";

export interface TextSection { heading: string; level: number; text: string }
export interface ExtractedHtml { title: string; cleanText: string; sections: TextSection[]; links: string[] }

export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? original;
    const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : "\uFFFD";
  });
}

const tidy = (text: string) => decodeEntities(text).replace(/\s+/g, " ").trim();

// Each lookup moves forward and remembers exhaustion, so overlapping malformed
// tags cannot make us scan the same suffix repeatedly.
function forwardSearch(source: string, character: string) {
  let found = -2;
  return (from: number): number => {
    if (found === -2 || (found >= 0 && found < from)) found = source.indexOf(character, from);
    return found;
  };
}

function* htmlTokens(source: string): Generator<string> {
  const tagEnd = forwardSearch(source, ">");
  const singleQuote = forwardSearch(source, "'");
  const doubleQuote = forwardSearch(source, '"');
  const closeSingle = forwardSearch(source, "'");
  const closeDouble = forwardSearch(source, '"');
  const endAfterSingle = forwardSearch(source, ">");
  const endAfterDouble = forwardSearch(source, ">");
  for (let position = 0; position < source.length;) {
    if (source[position] !== "<") {
      const next = source.indexOf("<", position);
      const end = next < 0 ? source.length : next;
      yield source.slice(position, end);
      position = end;
      continue;
    }
    let end = tagEnd(position + 1);
    if (end < 0) { position++; continue; }
    const single = singleQuote(position + 1);
    const double = doubleQuote(position + 1);
    const firstQuote = single >= 0 && (double < 0 || single < double) ? single : double;
    // Preserve the old tokenizer's quoted-attribute alternative and its fallback
    // to the first '>' when a quote or the following tag end is missing.
    if (firstQuote >= 0 && firstQuote < end) {
      const isSingle = firstQuote === single;
      const close = (isSingle ? closeSingle : closeDouble)(firstQuote + 1);
      const quotedEnd = close < 0 ? -1 : (isSingle ? endAfterSingle : endAfterDouble)(close + 1);
      if (quotedEnd >= 0) end = quotedEnd;
    }
    yield source.slice(position, end + 1);
    position = end + 1;
  }
}

// A small static-HTML tokenizer, not a browser: scripts are never executed.
export function extractHtml(html: string): ExtractedHtml {
  const title = tidy(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1].replace(/<[^>]*>/g, " ") ?? "");
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const links: string[] = [];
  const sections: TextSection[] = [];
  let hidden: string | undefined;
  let hiddenDepth = 0;
  let headingText = "";
  let headingLevel = 0;
  let section: TextSection = { heading: "", level: 0, text: "" };
  const flush = () => {
    section.text = tidy(section.text);
    if (section.heading || section.text) sections.push(section);
  };
  for (const token of htmlTokens(source)) {
    if (!token.startsWith("<")) {
      if (!hidden) { if (headingLevel) headingText += token; else section.text += token; }
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(token);
    if (!tag) continue;
    const closing = Boolean(tag[1]);
    const name = tag[2].toLowerCase();
    if (!closing && name === "a" && (!hidden || hidden === "nav" || hidden === "footer")) {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token);
      if (href) links.push(decodeEntities(href[1] ?? href[2] ?? href[3]));
    }
    if (hidden) {
      if (name === hidden) { hiddenDepth += closing ? -1 : 1; if (!hiddenDepth) hidden = undefined; }
      continue;
    }
    if (!closing && ["head", "nav", "footer", "template"].includes(name)) { hidden = name; hiddenDepth = 1; continue; }
    if (/^h[1-6]$/.test(name)) {
      if (!closing) { flush(); headingLevel = Number(name[1]); headingText = ""; }
      else { section = { heading: tidy(headingText), level: headingLevel, text: "" }; headingLevel = 0; }
    } else if (["p", "div", "br", "li", "section", "article", "main", "aside", "tr", "td"].includes(name)) {
      if (headingLevel) headingText += " "; else section.text += " ";
    }
  }
  if (headingLevel) section = { heading: tidy(headingText), level: headingLevel, text: "" };
  flush();
  return { title, sections, links, cleanText: sections.map((part) =>
    [part.heading ? `${"#".repeat(part.level)} ${part.heading}` : "", part.text].filter(Boolean).join("\n")).join("\n\n") };
}
