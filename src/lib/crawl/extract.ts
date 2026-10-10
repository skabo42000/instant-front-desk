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
  for (const token of source.match(/<[^>"']*(?:"[^"]*"|'[^']*')[^>]*>|<[^>]*>|[^<]+/g) ?? []) {
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
