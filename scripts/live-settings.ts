import { chmod, lstat, readFile, writeFile } from "node:fs/promises";

export async function readLocalSettings(): Promise<Record<string, string>> {
  let source: string;
  try {
    const info = await lstat(".env.local");
    if (!info.isFile() || info.isSymbolicLink()) throw Error("Invalid settings file");
    source = await readFile(".env.local", "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw Error("Cannot read local settings");
  }
  const settings: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2];
    settings[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
  }
  return settings;
}

// Preserve unrelated settings and comments. Generated secrets are never printed or put in argv.
export async function saveLocalSettings(updates: Record<string, string>): Promise<void> {
  await readLocalSettings(); // Reject symlinks before writing.
  let source = "";
  try { await chmod(".env.local", 0o600); source = await readFile(".env.local", "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot save local settings"); }
  const lines = source.split(/\r?\n/).filter(line => {
    const key = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    return !key || !(key in updates);
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n"\0]/.test(value)) throw Error("Invalid local setting");
    lines.push(`${key}="${value}"`);
  }
  await writeFile(".env.local", lines.join("\n") + "\n", { mode: 0o600 });
}
