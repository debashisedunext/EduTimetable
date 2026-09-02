/**
 * §13 — does the assistant's Markdown actually render?
 *
 *   docker compose exec web node /app/scripts/md-render-check.mjs
 *
 * The web app has no test runner, and adding one for a single component is a
 * bigger decision than this change deserves. But a parser with no test is a
 * parser nobody knows the state of — so this compiles the real component with
 * the TypeScript compiler (a direct devDependency) and renders it with
 * react-dom/server, then asserts on the HTML.
 *
 * It checks the cases that actually broke, and the ones that would break
 * quietly: a real class-timetable answer, escaped asterisks, a half-streamed
 * table, and — the one with teeth — that a model reply containing markup
 * cannot inject it.
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire("/app/apps/web/package.json");
// TypeScript, not esbuild: esbuild is a transitive dep of Vite and under
// pnpm's strict layout it does not resolve from here, while `typescript` is a
// direct devDependency and always will.
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const React = require("react");

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

// ── compile the real component, not a copy of it ──────────────────────────
const src = readFileSync("/app/apps/web/src/markdown.tsx", "utf8");
const { outputText } = ts.transpileModule(src, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
// Emitted BESIDE the source, not in /tmp: the compiled module imports
// `react/jsx-runtime`, which only resolves from inside the web package.
const tmp = "/app/apps/web/src/.markdown.check.mjs";
writeFileSync(tmp, outputText);
const { Markdown } = await import(pathToFileURL(tmp).href);

const html = (text) => renderToStaticMarkup(React.createElement(Markdown, { text }));

// ── 1. the answer from the screenshot ─────────────────────────────────────
console.log("A class timetable, as the assistant actually replies:");
const answer = [
  "### Class 5-A Weekly Timetable",
  "**Class Teacher:** Aditi Kapoor | **Strength:** 35",
  "",
  "| Period / Time | Mon | Tue |",
  "| :--- | :--- | :--- |",
  "| **P1** (08:00–08:37) | English *(Devansh Banerjee)* | Hindi *(Manav Verma)* |",
  "| **P2** (08:37–09:14) | Science *(Sneha Khanna)* | Computer *(Aditi Kapoor, Lab 1)* |",
].join("\n");
const out = html(answer);

check(out.includes("<table"), "a real <table> is emitted, not pipe text");
// `/<th/` also matches `<thead>` — count the real cells only.
check((out.match(/<th[ >]/g) || []).length === 3, "three header cells", `${(out.match(/<th[ >]/g) || []).length}`);
check((out.match(/<tr/g) || []).length === 3, "header row plus two body rows");
check(!out.includes("| :---"), "the delimiter row is consumed, never printed");
check(out.includes("<strong>P1</strong>"), "**bold** inside a cell becomes <strong>");
check(out.includes("<em>(Devansh Banerjee)</em>"), "*italic* inside a cell becomes <em>");
check(out.includes('role="heading"') && out.includes("Class 5-A Weekly Timetable"), "### becomes a heading");
check(out.includes("<strong>Class Teacher:</strong>"), "bold outside a table still works");

// ── 2. escapes ────────────────────────────────────────────────────────────
console.log("\nEscaped characters survive:");
const esc = html("Third Language Block\\* is one slot");
check(esc.includes("Block* is one slot"), "\\* renders a literal asterisk", esc.replace(/<[^>]+>/g, ""));
check(!esc.includes("<em>"), "and does not open an emphasis that swallows the line");

// ── 3. mid-stream fragments ───────────────────────────────────────────────
console.log("\nHalf-streamed answers do not throw or mangle:");
for (const [label, frag] of [
  ["a header with no delimiter yet", "| Period | Mon |"],
  ["a delimiter but no rows yet", "| Period | Mon |\n| :--- | :--- |"],
  ["an unclosed bold", "**Class Teacher:"],
  ["an unclosed code fence", "```\nsome output"],
  ["nothing at all", ""],
]) {
  let ok = true;
  let rendered = "";
  try { rendered = html(frag); } catch { ok = false; }
  check(ok, label, rendered.slice(0, 60).replace(/\n/g, " "));
}
check(!html("| Period | Mon |").includes("<table"),
  "a header alone stays a paragraph — a table appears only once its shape is known");
check(html("| Period | Mon |\n| :--- | :--- |").includes("<table"),
  "and becomes a table the moment the delimiter arrives");

// ── 4. injection ──────────────────────────────────────────────────────────
// The one with real consequences. Model output is shaped by tool results,
// which come from the database; a renderer that trusted it as markup would put
// an injection on a page already holding an admin's session.
console.log("\nModel output cannot inject markup:");
const nasty = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
check(!nasty.includes("<img") && !nasty.includes("<script"), "raw tags are escaped, never mounted");
check(nasty.includes("&lt;img") || nasty.includes("&lt;script"), "they appear as visible text instead");
const nastyCell = html("| A |\n| :--- |\n| <script>x</script> |");
check(!nastyCell.includes("<script>"), "including inside a table cell");

// ── 5. ragged rows ────────────────────────────────────────────────────────
console.log("\nA ragged table is still readable:");
const ragged = html("| A | B | C |\n| :--- | :--- | :--- |\n| 1 | 2 |");
check((ragged.match(/<td/g) || []).length === 3, "a short row is padded, not dropped",
  `${(ragged.match(/<td/g) || []).length} cells`);

// ── 6. alignment ──────────────────────────────────────────────────────────
const aligned = html("| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
check(aligned.includes("center") && aligned.includes("right"),
  "column alignment from the delimiter row is honoured");

unlinkSync(tmp);
console.log(failed ? "\nSOME MARKDOWN CHECKS FAILED" : "\nALL MARKDOWN CHECKS PASSED");
process.exit(failed);
