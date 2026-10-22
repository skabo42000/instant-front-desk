// Read frozen questions only; no database, credentials, model or network access.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/lib/question-intents.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const intents = {};
new Function("exports", compiled)(intents);

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(file) : entry.isFile() && entry.name.endsWith(".json") ? [file] : [];
  });
}
const sets = [];
const files = ["benchmarks", "data/benchmarks"].flatMap(jsonFiles).sort();
for (const file of files) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value.cases) || !value.cases.every(item => typeof item.question === "string")) continue;
  const matches = value.cases.filter(item => intents.isBusinessOverview(item.question)).map(item => ({ id: item.id, question: item.question }));
  sets.push({ file, questions: value.cases.length, matches });
}
const result = { roots: ["benchmarks", "data/benchmarks"], jsonFilesChecked: files.length,
  sets, totalQuestions: sets.reduce((sum, set) => sum + set.questions, 0),
  matchingQuestions: sets.reduce((sum, set) => sum + set.matches.length, 0) };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
