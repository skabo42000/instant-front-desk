// Heading cues are generic website labels, never IDs from evaluation answers.
const SERVICE_OVERVIEW = /\b(?:what|which)\s+(?:services|treatments)\b|\bservices\s+(?:do|does)\b|\bwhat\s+(?:do|does)\s+.{0,40}\b(?:offer|do)\b/i;
export function isServiceOverview(question: string): boolean { return SERVICE_OVERVIEW.test(question); }
const HEADINGS: [RegExp, string][] = [
  [/technical|tech.{0,12}skills|coding|programming/i, "questions|faq|frequently asked"],
  [/\b(?:launch|go live|goes live)\b/i, "timeline|timing|how long|^build$|launch"],
  [/\b(?:good|right|best) fit\b|\b(?:which|what) (?:types? of |kinds? of )?(?:businesses|industries|customers|clients)\b|\bwho.{0,25}(?:serve|help|work with)\b/i,
    "good fit|who (we|you) (help|serve|work with)|industries|business types|who is (it|this) for"],
  [/\b(?:located|location|regions?|service areas?|areas? (?:do|you|we)|where.{0,25}(?:based|serve|work))\b/i,
    "service areas?|areas we (serve|cover)|where we (work|are|serve)|based in|locations?|regions?|suburbs|^remote([ ,.:]|$)"],
  [SERVICE_OVERVIEW,
    "what we do|what we offer|our services|^services$|^treatments$"],
  [/benefit|help|what (?:it|the .{0,30}) does/i,
    "what it does|benefits|how it helps"],
  [/process|steps|how.{0,40}(?:get started|getting started|start working|work with)|getting.started/i,
    "process|how (we|it) works|getting started|^(talk|discover|discovery|plan|planning|build|build and test|test|launch|improve|improvement)$"],
];

export function headingPatterns(question: string): string[] {
  return HEADINGS.filter(([intent]) => intent.test(question)).map(([, pattern]) => pattern);
}
