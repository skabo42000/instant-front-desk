import { resolve } from "node:path";

// Reports go under the project folder. Tests set IFD_OUTPUT_ROOT to a temp folder so they never
// mix fake reports with real run reports.
export function outputPath(...parts: string[]): string {
  return resolve(process.env.IFD_OUTPUT_ROOT ?? ".", ...parts);
}
