import "server-only";

interface Rule { allow: boolean; pattern: string }

// Use the wildcard group: the crawler does not impersonate another named bot.
export function parseRobots(text: string): (url: URL) => boolean {
  const rules: Rule[] = [];
  let agents: string[] = [];
  let hasRules = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line.split("#")[0]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "user-agent") {
      if (hasRules) { agents = []; hasRules = false; }
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      hasRules = true;
      if (agents.includes("*") && value) rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const compiled = rules.map((rule) => {
    const pattern = normalize(rule.pattern);
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    return { ...rule, anchored, pieces: body.split("*"), specificity: Buffer.byteLength(body.replace(/\*/g, "")) };
  });
  return (url) => {
    const path = normalize(url.pathname + url.search);
    let winner: Rule | undefined;
    let length = -1;
    for (const rule of compiled) {
      if (matches(path, rule.pieces, rule.anchored) &&
          (rule.specificity > length || (rule.specificity === length && rule.allow))) {
        winner = rule; length = rule.specificity;
      }
    }
    return winner?.allow ?? true;
  };
}

// Literal searches avoid regex backtracking on untrusted wildcard rules.
function matches(path: string, pieces: string[], anchored: boolean): boolean {
  if (!path.startsWith(pieces[0])) return false;
  let offset = pieces[0].length;
  if (pieces.length === 1) return !anchored || offset === path.length;
  for (let index = 1; index < pieces.length; index++) {
    const piece = pieces[index];
    if (anchored && index === pieces.length - 1) return path.endsWith(piece) && path.length - piece.length >= offset;
    const found = path.indexOf(piece, offset);
    if (found < 0) return false;
    offset = found + piece.length;
  }
  return true;
}

function normalize(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (encoded) => {
    const character = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /[a-z0-9._~-]/i.test(character) ? character : encoded.toUpperCase();
  });
}
