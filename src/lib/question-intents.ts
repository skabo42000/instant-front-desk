// Heading cues are generic website labels, never IDs from evaluation answers.
const HEADINGS: [RegExp, string][] = [
  [/\b(?:what|which)\s+(?:services|treatments)\b|\bservices\s+(?:do|does)\b|\bwhat\s+(?:do|does)\s+.{0,40}\b(?:offer|do)\b/i,
    "what we do|what we offer|our services|^services$|^treatments$"],
  [/benefit|help|what (?:it|the .{0,30}) does/i,
    "what it does|benefits|how it helps"],
  [/process|steps|how.{0,40}(?:get started|getting started|start working|work with)|getting.started/i,
    "process|how (we|it) works|getting started|^(talk|discover|discovery|plan|planning|build|build and test|test|launch|improve|improvement)$"],
];

export function headingPatterns(question: string): string[] {
  return HEADINGS.filter(([intent]) => intent.test(question)).map(([, pattern]) => pattern);
}
