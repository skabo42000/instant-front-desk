import "server-only";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

// Operator-owned directory, shared by every process using the same provider budget.
// This sticky marker is only removed during a deliberate operator budget reset.
export class LocalProviderStop {
  private readonly directory: string;
  constructor(directory = "data/provider-stop") { this.directory = resolve(directory); }

  private prepare(): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory()) throw Error("Invalid stop directory");
    return join(this.directory, "quota-stop");
  }

  exists(): boolean {
    const file = this.prepare();
    try { lstatSync(file); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw Error("Local provider stop unavailable");
    }
  }

  mark(): void {
    const file = this.prepare();
    // Never truncate or unlink: concurrent writers/readers must not erase a stop.
    let fd: number;
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw Error("Local provider stop unavailable");
    }
    try { writeSync(fd, "quota-stop-v1\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    const directoryFd = openSync(this.directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}
