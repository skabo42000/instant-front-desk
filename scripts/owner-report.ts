import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderOwnerReport } from "../src/lib/owner-report";

export async function main(args: string[]) {
  if (args.length !== 3 || !args[1].endsWith(".html")) throw new Error("Invalid arguments");
  const [report, benchmark] = await Promise.all([args[0], args[2]].map(async path => JSON.parse(await readFile(path, "utf8"))));
  const html = renderOwnerReport(report, benchmark);
  const output = resolve(args[1]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, { mode: 0o600, flag: "wx" });
  console.log("Owner report saved.");
}
