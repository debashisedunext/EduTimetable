---
name: explain-code
description: Explain EduTimetable code, schema, or architecture in simple, non-technical language using school-timetabling analogies. Use when the user asks to "explain", "understand", "what does this do", "how does this work", or wants a walkthrough of a file, module, or concept in plain English.
---

# Explain Code in Simple Language

Explain the requested code, file, schema, or concept so that a smart non-programmer (e.g., a school administrator or a product manager) can follow it. The reader knows schools and timetables well — use that domain, not programming jargon.

## Steps

1. **Read the actual target.** Read the file(s)/section the user pointed at (or find them). Never explain from memory of what the code "probably" does. If the user names a concept rather than a file (e.g., "the solver", "feasibility checks"), locate the code if it exists, else explain from the relevant § of `AI-Timetable-System-Architecture.md` and say the explanation is based on the spec.
2. **Explain in three layers**, in this order:
   - **What it does** — one or two sentences, outcome only. ("This piece makes sure no teacher is ever booked in two classrooms at the same time.")
   - **How it works** — a short numbered walkthrough in plain English, following the real flow of the code. Use timetabling analogies: a CSP variable is "an empty cell on the grid that needs a subject"; domain pruning is "crossing out slots a teacher is never allowed to have, before we even start filling the grid"; a unique DB key is "a rule the filing cabinet itself refuses to break, even if the clerk makes a mistake".
   - **Why it exists** — the requirement or invariant it serves, citing the spec section (e.g., "this is invariant #2 in CLAUDE.md / §4.7 of the architecture doc").
3. **Translate every unavoidable technical term** the first time it appears: "backtracking (trying a placement, and undoing it if it leads to a dead end)". Prefer everyday words: "list" not "array", "rule" not "constraint" (after introducing it once), "saved" not "persisted".
4. **Show, don't dump.** Quote at most a few short lines of code when they genuinely help; describe the rest. Never paste whole functions into the explanation.
5. **End with a one-paragraph summary** and, if useful, one "watch out" note (a subtlety a future editor could easily break).

## Style rules

- Full sentences, no bullet fragments in the walkthrough.
- No unexplained acronyms (CSP, MRV, RBAC, DnD, ORM …) — expand and gloss each on first use.
- Calibrate depth to the ask: "briefly explain" → the What + Why layers only; "walk me through" → all three layers.
- If the code contradicts the spec, say so explicitly — that's a finding, not something to paper over.
