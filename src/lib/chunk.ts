import "server-only";
import { createHash } from "node:crypto";
import { hasSourceInstructions } from "./source-safety";
import type { TextSection } from "./crawl/extract";

export const MAX_CHUNK_LENGTH = 800;
export const CHUNK_OVERLAP = 80;
export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function stableId(value: string): string {
  const hash = contentHash(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export interface TextChunk {
  id: string; ordinal: number; heading: string; text: string; contentHash: string;
}

export function chunkPage(pageUrl: string, sections: readonly TextSection[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    // A hostile heading applies to the whole section, including every split chunk.
    if (hasSourceInstructions(section.heading)) continue;
    const text = section.text.replace(/\s+/g, " ").trim();
    const heading = section.heading.replace(/\s+/g, " ").trim();
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + MAX_CHUNK_LENGTH, text.length);
      // Avoid splitting a word where possible, with a hard cap for very long words.
      if (end < text.length) {
        const space = text.lastIndexOf(" ", end);
        if (space > start + MAX_CHUNK_LENGTH / 2) end = space;
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
      }
      const part = text.slice(start, end).trim();
      const ordinal = chunks.length;
      const hash = contentHash(JSON.stringify([heading, part]));
      chunks.push({ id: stableId(JSON.stringify([pageUrl, ordinal, hash])), ordinal,
        heading, text: part, contentHash: hash });
      if (end === text.length) break;
      start = end - CHUNK_OVERLAP;
      if (/[\uDC00-\uDFFF]/.test(text[start])) start += 1;
    }
  }
  return chunks;
}
