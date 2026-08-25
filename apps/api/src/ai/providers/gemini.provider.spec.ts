/**
 * The Gemini adapter's translation layer (§13).
 *
 * These pin the two places where Gemini differs from Anthropic badly enough to
 * break things silently: its stricter schema dialect, and its lack of tool-call
 * ids. Both are pure functions, so they can be tested without a network or a
 * key — which matters, because the failure mode of getting them wrong is a 400
 * that takes down the *entire* tool registry, not one tool.
 */
import { describe, expect, it } from "vitest";
import {
  parseSseEvent,
  splitSseEvents,
  toGeminiContents,
  toGeminiSchema,
  toGeminiTools,
} from "./gemini.provider";
import { TOOL_DEFS } from "../tools";
import type { LlmMessage } from "./types";

describe("toGeminiSchema", () => {
  it("upper-cases types, as the OpenAPI subset requires", () => {
    expect(toGeminiSchema({ type: "string" })).toEqual({ type: "STRING" });
    expect(toGeminiSchema({ type: "integer" })).toEqual({ type: "INTEGER" });
  });

  it("drops minimum/maximum, which Gemini rejects, but keeps the meaning", () => {
    // §13.1's day-of-week argument uses both. Passing them through would 400
    // the whole request; dropping them silently would lose the constraint the
    // model actually steers on, so they move into the description.
    const out = toGeminiSchema({
      type: "integer",
      minimum: 1,
      maximum: 7,
      description: "day of week, 1 = Monday … 7 = Sunday",
    });
    expect(out).not.toHaveProperty("minimum");
    expect(out).not.toHaveProperty("maximum");
    expect(out!.description).toContain("day of week");
    expect(out!.description).toContain("range 1–7");
  });

  it("omits an empty properties object rather than sending one", () => {
    // Gemini rejects an OBJECT whose `properties` is empty, which several
    // no-argument tools legitimately have.
    expect(toGeminiSchema({ type: "object", properties: {} })).toEqual({ type: "OBJECT" });
  });

  it("recurses through properties and array items", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer", minimum: 1 } },
        name: { type: "string" },
      },
      required: ["ids"],
    });
    expect(out).toEqual({
      type: "OBJECT",
      properties: {
        ids: { type: "ARRAY", items: { type: "INTEGER", description: "range 1–any" } },
        name: { type: "STRING" },
      },
      required: ["ids"],
    });
  });

  it("keeps enums, as strings", () => {
    expect(toGeminiSchema({ type: "string", enum: ["draft", "published"] })).toEqual({
      type: "STRING",
      enum: ["draft", "published"],
    });
  });
});

describe("toGeminiTools", () => {
  it("translates the whole §13.1 registry without emitting a rejected keyword", () => {
    const declared = toGeminiTools(TOOL_DEFS)![0].functionDeclarations;
    expect(declared).toHaveLength(TOOL_DEFS.length);

    // Anything Gemini rejects, anywhere in the tree, is a 400 for every tool.
    const json = JSON.stringify(declared);
    for (const rejected of ["minimum", "maximum", "additionalProperties", "$schema"]) {
      expect(json).not.toContain(`"${rejected}"`);
    }
  });

  it("omits `parameters` entirely for a tool that takes no arguments", () => {
    const declared = toGeminiTools([
      { name: "getTimetableConfigs", description: "…", input_schema: { type: "object", properties: {} } },
    ])![0].functionDeclarations[0];
    expect(declared).not.toHaveProperty("parameters");
  });

  it("returns undefined for an empty tool list", () => {
    expect(toGeminiTools([])).toBeUndefined();
  });
});

describe("toGeminiContents", () => {
  it("maps a plain exchange to user/model turns", () => {
    const messages: LlmMessage[] = [
      { role: "user", text: "who teaches 5-A on Monday?" },
      { role: "assistant", text: "Let me check." },
    ];
    expect(toGeminiContents(messages)).toEqual([
      { role: "user", parts: [{ text: "who teaches 5-A on Monday?" }] },
      { role: "model", parts: [{ text: "Let me check." }] },
    ]);
  });

  it("carries a tool call and its result back by name", () => {
    // Gemini has no tool_use ids — it correlates on the function name — so the
    // round trip has to survive without them.
    const messages: LlmMessage[] = [
      { role: "user", text: "list teachers" },
      { role: "assistant", text: "", toolCalls: [{ id: "listTeachers-0", name: "listTeachers", args: {} }] },
      { role: "tool", results: [{ id: "listTeachers-0", name: "listTeachers", content: '{"rows":[]}' }] },
    ];
    const out = toGeminiContents(messages);
    expect(out[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "listTeachers", args: {} } }] });
    expect(out[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "listTeachers", response: { result: '{"rows":[]}' } } }],
    });
  });

  it("passes a tool error through as data the model can read", () => {
    const out = toGeminiContents([
      { role: "tool", results: [{ id: "x-0", name: "getTeacherTimetable", content: "out of scope", isError: true }] },
    ]);
    expect(out[0].parts[0].functionResponse!.response).toEqual({ error: "out of scope" });
  });

  it("skips an assistant turn with nothing in it", () => {
    // An empty `parts` array is rejected; a turn that produced neither text nor
    // a call has nothing to replay anyway.
    expect(toGeminiContents([{ role: "assistant", text: "   " }])).toEqual([]);
  });
});

describe("SSE framing", () => {
  // Captured from a real gemini-3.7-flash streamGenerateContent response.
  // Google separates events with CRLF, which is what broke the first cut: a
  // reader looking for "\n\n" finds no boundary in "\r\n\r\n" (there is a \r
  // between the two newlines), so it yields nothing at all — no text, no tool
  // calls, no token counts, and an empty answer bubble with no error to explain
  // it. That is the single most important case in this file.
  const REAL = 'data: {"candidates": [{"content": {"parts": [{"text": "Hello"}],"role": "model"},"index": 0}]}\r\n\r\n';

  it("splits CRLF-separated events, as Google actually sends them", () => {
    const { events, rest } = splitSseEvents(REAL);
    expect(events).toHaveLength(1);
    expect(rest).toBe("");
    expect((parseSseEvent(events[0]) as any).candidates[0].content.parts[0].text).toBe("Hello");
  });

  it("splits LF-separated events too", () => {
    const { events } = splitSseEvents('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(events).toHaveLength(2);
    expect(parseSseEvent(events[1])).toEqual({ a: 2 });
  });

  it("keeps a partial event buffered rather than dropping it", () => {
    // A network chunk can split mid-event; the remainder must survive to be
    // completed by the next read.
    const { events, rest } = splitSseEvents('data: {"a":1}\r\n\r\ndata: {"b":');
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"b":');
  });

  it("ignores comments, keep-alives and [DONE]", () => {
    expect(parseSseEvent(": keep-alive")).toBeNull();
    expect(parseSseEvent("data: [DONE]")).toBeNull();
    expect(parseSseEvent("")).toBeNull();
  });

  it("does not throw on a malformed payload", () => {
    expect(parseSseEvent("data: {not json")).toBeNull();
  });
});
