// Small driver boundary; application code uses only these pool operations.
declare module "pg" {
  export class Pool {
    constructor(options: Record<string, unknown>);
    connect(): Promise<{ query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(error?: boolean): void }>;
    on(event: "error", handler: () => void): this;
    end(): Promise<void>;
  }
}
