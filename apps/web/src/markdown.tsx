/**
 * §13 — rendering the assistant's answers.
 *
 * The LLM replies in Markdown: headings, bold, and — the reason this file
 * exists — GFM tables. A class's week, a teacher's load, a room's utilisation
 * are all tables, and a table printed as `| P1 | English | Hindi |` is data the
 * reader has to parse by eye. The bubble used to render the raw string inside
 * `white-space: pre-wrap`, so every answer arrived as pipe soup.
 *
 * Two decisions worth stating.
 *
 * **It builds React elements, never HTML.** No `dangerouslySetInnerHTML`
 * anywhere. This is model output, which is influenced by tool results, which
 * come from the database — treating any of that as trusted markup is how an
 * injection lands on a page that already holds an admin's session. A renderer
 * that can only ever produce elements cannot inject.
 *
 * **It is deliberately small, not a Markdown library.** The assistant emits a
 * narrow, known subset — the §13.1 tool registry answers with tables, short
 * headings and emphasis. A general parser (react-markdown + remark-gfm) is
 * ~100KB of dependency for that subset, against a `dependencies` list of six.
 * Anything unrecognised falls through as plain text, which is exactly what the
 * old behaviour was, so the worst case is no worse than before.
 *
 * It must also survive **half a document**: answers stream token by token, so
 * this is called on a table with no delimiter row yet, a `**` with no closer,
 * an unterminated code fence. Every branch below degrades to text rather than
 * throwing.
 */
import { type ReactNode } from "react";

/* ────────────────────────── escapes ──────────────────────────
 * A backslash escape has to survive parsing: the assistant writes
 * `Third Language Block\*` meaning a literal asterisk, and treating it as
 * emphasis swallows the rest of the line. Escaped characters are swapped for
 * a sentinel before any pattern runs, and restored only in leaf text.
 */
/** A private-use codepoint, written as an ESCAPE so this file stays plain
 *  text — a literal control character makes the source a binary blob to
 *  grep and to half the toolchain. No answer can contain it. */
const SENTINEL = "\uE000";
const RESTORE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");

function protect(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, (_m, c: string) => `${SENTINEL}${c.charCodeAt(0)}${SENTINEL}`);
}

function restore(s: string): string {
  return s.replace(RESTORE, (_m, n: string) => String.fromCharCode(Number(n)));
}

/* ────────────────────────── inline ────────────────────────── */

/**
 * `code`, then `**bold**`, then `*italic*` — in that order, so `**` inside a
 * code span stays literal and `**a**` is not mistaken for two italics.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let n = 0;

  // Code spans first: their contents are never parsed further.
  const codeSplit = text.split(/(`[^`\n]+`)/g);
  for (const chunk of codeSplit) {
    if (!chunk) continue;
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 2) {
      out.push(<code className="md-code" key={`${key}-c${n++}`}>{restore(chunk.slice(1, -1))}</code>);
      continue;
    }
    out.push(...emphasis(chunk, `${key}-e${n++}`));
  }
  return out;
}

function emphasis(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let n = 0;
  // `**bold**` and `__bold__`, non-greedy so two pairs on one line both close.
  for (const chunk of text.split(/(\*\*[^*]+\*\*|__[^_]+__)/g)) {
    if (!chunk) continue;
    if ((chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4) ||
        (chunk.startsWith("__") && chunk.endsWith("__") && chunk.length > 4)) {
      out.push(<strong key={`${key}-b${n++}`}>{italic(chunk.slice(2, -2), `${key}-b${n}`)}</strong>);
      continue;
    }
    out.push(...italic(chunk, `${key}-i${n++}`));
  }
  return out;
}

function italic(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let n = 0;
  for (const chunk of text.split(/(\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))/g)) {
    if (!chunk) continue;
    if ((chunk.startsWith("*") && chunk.endsWith("*") && chunk.length > 2) ||
        (chunk.startsWith("_") && chunk.endsWith("_") && chunk.length > 2)) {
      out.push(<em key={`${key}-m${n++}`}>{restore(chunk.slice(1, -1))}</em>);
      continue;
    }
    out.push(restore(chunk));
  }
  return out;
}

/* ────────────────────────── blocks ────────────────────────── */

/** `|:---|---:|:---:|` — the row that turns a run of pipes into a table. */
const DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isDelimiter(line: string): boolean {
  return line.includes("-") && DELIMITER.test(line);
}

function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function alignOf(spec: string): "left" | "center" | "right" {
  const s = spec.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  return "left";
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  const lines = protect(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    // Single newlines inside a paragraph are a soft break, not a new block —
    // the assistant wraps prose, and joining with a space would run sentences
    // together while <br/> keeps the shape it wrote.
    const nodes: ReactNode[] = [];
    buf.forEach((line, n) => {
      if (n > 0) nodes.push(<br key={`br${k}-${n}`} />);
      nodes.push(...inline(line, `p${k}-${n}`));
    });
    blocks.push(<p className="md-p" key={`p${k++}`}>{nodes}</p>);
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // ── fenced code ──────────────────────────────────────────
    const fence = line.match(/^\s*```+(.*)$/);
    if (fence) {
      flushParagraph(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence, or end of a still-streaming answer
      blocks.push(
        <pre className="md-pre" key={`f${k++}`}><code>{restore(body.join("\n"))}</code></pre>,
      );
      continue;
    }

    // ── table ────────────────────────────────────────────────
    // Needs the header AND the delimiter to be present. Mid-stream, a header
    // alone is still just a paragraph — which is why this looks ahead.
    if (line.includes("|") && i + 1 < lines.length && isDelimiter(lines[i + 1])) {
      flushParagraph(para);
      const header = cells(line);
      const aligns = cells(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i++]));
      }
      blocks.push(
        <div className="md-table-wrap" key={`t${k++}`}>
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, c) => (
                  <th key={c} style={{ textAlign: aligns[c] ?? "left" }}>{inline(h, `th${k}-${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {/* Pad short rows rather than dropping the cells: a ragged
                      row is the model's slip, not a reason to lose data. */}
                  {header.map((_, c) => (
                    <td key={c} style={{ textAlign: aligns[c] ?? "left" }}>{inline(r[c] ?? "", `td${k}-${ri}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // ── heading ──────────────────────────────────────────────
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(para);
      const level = Math.min(heading[1].length, 6);
      blocks.push(
        <div className={`md-h md-h${level}`} key={`h${k++}`} role="heading" aria-level={level}>
          {inline(heading[2], `h${k}`)}
        </div>,
      );
      i++;
      continue;
    }

    // ── horizontal rule ──────────────────────────────────────
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph(para);
      blocks.push(<hr className="md-hr" key={`hr${k++}`} />);
      i++;
      continue;
    }

    // ── lists ────────────────────────────────────────────────
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph(para);
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          : lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const children = items.map((it, n) => <li key={n}>{inline(it, `li${k}-${n}`)}</li>);
      blocks.push(
        ordered
          ? <ol className="md-list" key={`l${k++}`}>{children}</ol>
          : <ul className="md-list" key={`l${k++}`}>{children}</ul>,
      );
      continue;
    }

    // ── blockquote ───────────────────────────────────────────
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para);
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote className="md-quote" key={`q${k++}`}>{inline(quoted.join(" "), `q${k}`)}</blockquote>,
      );
      continue;
    }

    // ── blank line closes a paragraph ────────────────────────
    if (line.trim() === "") {
      flushParagraph(para);
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushParagraph(para);

  return <div className="md">{blocks}</div>;
}
