import { describe, expect, it } from "vitest";
import { FakeModel } from "@/lib/models/fake";
import type { ModelRequest } from "@/lib/types";

const request: ModelRequest = { businessId: "fixture-business", question: "When are you open?", sources: [] };

describe("offline fake model", () => {
  it("returns ordered scripted replies and fails on exhaustion", async () => {
    const model = new FakeModel([
      { text: "Tuesday to Saturday, 10 AM to 6 PM.", citedChunkIds: ["hours"] },
      { text: "The website does not list prices.", citedChunkIds: [] },
    ]);
    expect(await model.generate(request)).toEqual({
      text: "Tuesday to Saturday, 10 AM to 6 PM.", citedChunkIds: ["hours"],
    });
    expect(await model.generate(request)).toEqual({ text: "The website does not list prices.", citedChunkIds: [] });
    await expect(model.generate(request)).rejects.toThrow("Fake model has no scripted replies left.");
  });

  it("keeps scripted data independent from caller mutations", async () => {
    const reply = { text: "Original", citedChunkIds: ["original"] };
    const model = new FakeModel([reply, reply]);
    reply.text = "Changed";
    const first = await model.generate(request);
    first.citedChunkIds.push("changed");
    expect(await model.generate(request)).toEqual({ text: "Original", citedChunkIds: ["original"] });
  });
});
