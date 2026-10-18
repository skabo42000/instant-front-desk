import { expect, it } from "vitest";
import { answer } from "../../src/lib/answer";
import { ModelGateway } from "../../src/lib/models/gateway";

it("refusals list each contact once, even when a page repeats a number in another format", async () => {
  const contact = { id: "visit", heading: "Visit the Lounge", pageUrl: "https://salon.example/",
    text: "Call +1 779-234-5125 to book. Questions? 779-234-5125 or Hello@Salon.example, or hello@salon.example." };
  const result = await answer("What is the exact price of an unlisted custom VIP package?", [contact], new ModelGateway({}), [contact]);
  expect(result.kind).toBe("refusal");
  expect(result.text).toContain("You can contact the business at +1 779-234-5125 or Hello@Salon.example.");
  expect(result.text.match(/779-234-5125/g)).toHaveLength(1);
});
