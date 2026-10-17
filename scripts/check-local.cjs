// HTTP checks only: no valid chat questions and no provider calls.
const assert = require("node:assert/strict");
async function main() {
  const base = "http://127.0.0.1:3000";
  const get = path => fetch(base + path, { signal: AbortSignal.timeout(20000) });
  const home = await get("/");
  assert.equal(home.status, 200, "Home page should open");
  const html = await home.text();
  assert.ok(html.includes("Instant Front Desk"));
  const pages = [...new Set([...html.matchAll(/href="(\/b\/[a-z0-9-]+)"/g)].map(match => match[1]))];
  for (const page of pages.slice(0, 15)) assert.equal((await get(page)).status, 200, "Saved business page should open");
  assert.equal((await get("/b/missing-smoke-check-business")).status, 404);
  const invalid = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "missing-smoke-check-business", question: "" }), signal: AbortSignal.timeout(20000) });
  assert.equal(invalid.status, 400, "Invalid input should fail before provider calls");
  console.log(JSON.stringify({ home: 200, businessPagesChecked: Math.min(pages.length, 15), unknownBusiness: 404, invalidChat: 400, modelCalls: 0 }));
}
main().catch(() => { console.error("Local HTTP check failed. Start the server with npm run dev (or npm start after a build), then inspect its terminal for details."); process.exitCode = 1; });
