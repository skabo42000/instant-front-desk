import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { phrasePatterns } = await import("../../src/lib/retrieve");

const matches = (question: string, text: string) =>
  phrasePatterns(question).some(pattern => new RegExp(pattern.replace(/\\m/g, "\\b"), "i").test(text));

describe("phrasePatterns", () => {
  it("finds sections that repeat the question's own word pairs", () => {
    expect(matches("What types of businesses are a good fit?", "Any business with repetitive work is a good fit, including")).toBe(true);
    expect(matches("Do I need to change my existing software?", "Do I need to change my software? Usually not.")).toBe(true);
    expect(matches("What kinds of service providers do you use?", "We use a small number of service providers")).toBe(true);
  });
  it("ignores stop words and unrelated text", () => {
    expect(phrasePatterns("What is the of a?")).toEqual([]);
    expect(matches("Do I need to change my existing software?", "We repair cars and trucks.")).toBe(false);
  });
});
