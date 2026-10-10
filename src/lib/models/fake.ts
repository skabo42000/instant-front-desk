import "server-only";
import type { ModelAdapter, ModelReply, ModelRequest } from "../types";

// Scripted replies are test data, not a real answer or grounding engine.
export class FakeModel implements ModelAdapter {
  private nextReply = 0;
  private readonly replies: readonly ModelReply[];

  constructor(replies: readonly ModelReply[]) {
    this.replies = structuredClone(replies);
  }

  async generate(_request: ModelRequest): Promise<ModelReply> {
    const reply = this.replies[this.nextReply];
    if (!reply) throw new Error("Fake model has no scripted replies left.");
    this.nextReply += 1;
    return structuredClone(reply);
  }
}
