/**
 * §13.5 — the floating assistant.
 *
 * The same conversation as the Ask AI screen, reachable without leaving the
 * page you are on — which is the point: master data gets added while you are
 * looking at the screen that told you it was missing.
 *
 * It asks *and* adds. The drafting tool is offered only to users the server
 * says hold `masters.manage`, and the server enforces that independently: the
 * quick prompts below are a convenience, never the gate.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COMMON_SUBJECTS, PERMISSIONS } from "@edutimetable/shared";
import { Markdown } from "../markdown";
import { useConfigCtx } from "../hooks";
import { ProposalCard } from "./ProposalCard";
import { useAiChat } from "./useAiChat";

/** Starting points for the things people come here to do. */
const QUICK = [
  { label: "Add classes & sections", prompt: "I want to add new classes with their sections. Ask me what I need to tell you." },
  { label: "Add teachers", prompt: "I want to add teachers. Ask me for what you need — employee codes and names at minimum." },
  { label: "Set curriculum", prompt: "I want to set the curriculum — which subjects a class takes and how many periods a week. Ask me what you need." },
  { label: "Map teachers to subjects", prompt: "I want to map teachers to the subjects and class-sections they teach. Ask me what you need." },
  // Phase C: the two that CHANGE something. They read differently on purpose —
  // people ask to "move" a subject, not to "update a mapping row".
  { label: "Move a subject to another teacher", prompt: "I want to change who teaches a subject in a class-section. Show me what is mapped there now, then ask me who should take it." },
  { label: "Change a class teacher", prompt: "I want to change which teacher owns a class-section. Show me who has it now, then ask me who should." },
];

/**
 * The button that opens the assistant, in either of its two homes.
 *
 * One component with a placement flag rather than two markups: a launcher that
 * looked different in the bar from the way it looked floating would be two
 * things to keep in step, and the one in the fallback is the one nobody sees
 * until it matters.
 */
function Launcher({ open, onToggle, inBar = false }: {
  open: boolean;
  onToggle: () => void;
  inBar?: boolean;
}) {
  return (
    <button
      aria-label={open ? "Close the assistant" : "Open the assistant"}
      aria-expanded={open}
      onClick={onToggle}
      title="Ask the timetable assistant"
      style={{
        border: "none", cursor: "pointer", color: "#fff",
        background: open ? "var(--brand-deep)" : "var(--brand)",
        display: "grid", placeItems: "center",
        ...(inBar
          ? { width: 34, height: 34, borderRadius: 10, fontSize: 15 }
          : {
            position: "fixed", right: 22, bottom: 22, zIndex: 60,
            width: 52, height: 52, borderRadius: "50%", fontSize: 20,
            boxShadow: "0 6px 20px rgba(11,31,68,0.28)",
          }),
      }}
    >
      {open ? "✕" : "✦"}
    </button>
  );
}

export function AiDock({ permissions }: { permissions: string[] }) {
  const { current } = useConfigCtx();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [picker, setPicker] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * §31.10 — the top bar's slot for this launcher.
   *
   * `useLayoutEffect` rather than `useEffect`: the fallback below draws the old
   * floating button when there is no slot, and a passive effect would show it
   * for one painted frame before the portal moved it — a button that jumps out
   * of the corner on every page load.
   */
  const [launcherSlot, setLauncherSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setLauncherSlot(document.getElementById("ai-launcher-slot"));
  }, []);
  const { messages, busy, error, ask, reset } = useAiChat(current?.id ?? null);

  const canChat = permissions.includes(PERMISSIONS.AI_CHAT);
  const canWrite = permissions.includes(PERMISSIONS.MASTERS_MANAGE);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  if (!canChat) return null;

  const send = (q: string) => { ask(q); setInput(""); setPicker(false); };

  const addChosenSubjects = () => {
    if (chosen.length === 0) return;
    const all = COMMON_SUBJECTS.flatMap((g) => g.subjects);
    const lines = chosen.map((n) => {
      const s = all.find((x) => x.name === n);
      return s ? `${s.name} (code ${s.code}${s.isLab ? ", lab subject" : ""})` : n;
    });
    send(`Add these subjects: ${lines.join("; ")}.`);
    setChosen([]);
  };

  return (
    <>
      {/*
        The launcher, in the top bar when there is one to sit in.

        It used to float at the bottom-right of every screen, which is fine
        until a screen puts something there — on the Master Grid it covered the
        strip's issue count. A floating button cannot know what it is on top of,
        so it stops floating.

        The fallback keeps the old corner button for any future shell that has
        no slot: losing the assistant entirely because a `<span>` was not
        rendered would be a worse failure than a button in an awkward place.
      */}
      {launcherSlot
        ? createPortal(<Launcher open={open} onToggle={() => setOpen((o) => !o)} inBar />, launcherSlot)
        : <Launcher open={open} onToggle={() => setOpen((o) => !o)} />}

      {open && (
        <div
          role="dialog"
          aria-label="Timetable assistant"
          style={{
            // Hangs from the bar the launcher is in, rather than rising from a
            // corner it no longer occupies.
            position: "fixed", right: 22, top: 74, zIndex: 59,
            width: "min(430px, calc(100vw - 44px))", height: "min(620px, calc(100vh - 100px))",
            display: "flex", flexDirection: "column",
            background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
            boxShadow: "0 16px 48px rgba(11,31,68,0.22)", overflow: "hidden",
          }}
        >
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "11px 14px",
            borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
          }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>Timetable Assistant</span>
            <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
              {canWrite ? "asks, adds and changes" : "read-only"}
            </span>
            <button
              onClick={reset}
              style={{ marginLeft: "auto", border: "1px solid var(--line)", background: "var(--paper)",
                borderRadius: 7, padding: "3px 9px", fontSize: 11.5, cursor: "pointer" }}
            >
              New
            </button>
          </div>

          <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <>
                <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                  Ask about the timetable{canWrite ? ", or tell me what master data to add or change. I draft it and you press Apply — I never write anything myself." : "."}
                </div>
                {canWrite && (
                  <>
                    <div style={{ display: "grid", gap: 6 }}>
                      {QUICK.map((q) => (
                        <button key={q.label} onClick={() => send(q.prompt)}
                          style={chip}>{q.label}</button>
                      ))}
                      <button onClick={() => setPicker((p) => !p)} style={chip}>
                        Add subjects from a list…
                      </button>
                    </div>
                    {picker && (
                      <div style={{ border: "1px solid var(--line)", borderRadius: 9, padding: 10 }}>
                        {COMMON_SUBJECTS.map((g) => (
                          <div key={g.group} style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em",
                              color: "var(--ink-faint)", marginBottom: 4 }}>{g.group}</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                              {g.subjects.map((s) => {
                                const on = chosen.includes(s.name);
                                return (
                                  <button key={s.name}
                                    onClick={() => setChosen((c) => on ? c.filter((x) => x !== s.name) : [...c, s.name])}
                                    style={{
                                      ...chip, padding: "3px 9px", fontSize: 11.5,
                                      background: on ? "var(--brand)" : "var(--paper)",
                                      color: on ? "#fff" : "var(--ink)",
                                      borderColor: on ? "var(--brand)" : "var(--line)",
                                    }}>{s.name}</button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        <button className="btn btn-primary" style={{ padding: "5px 12px", fontSize: 12 }}
                          onClick={addChosenSubjects} disabled={chosen.length === 0}>
                          Draft {chosen.length || ""} subject{chosen.length === 1 ? "" : "s"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "100%" }}>
                {(m.text || !m.streaming) && (
                  <div className="bubble">
                    {m.role === "ai" ? <Markdown text={m.text} /> : m.text}
                  </div>
                )}
                {m.streaming && !m.text && (m.proposals ?? []).length === 0 && (
                  <div className="bubble typing"><span /><span /><span /></div>
                )}
                {m.proposals?.map((p, j) => (
                  <ProposalCard key={j} proposal={p} onApplied={() => { /* card shows its own state */ }} />
                ))}
              </div>
            ))}

            {error && (
              <div style={{ fontSize: 12.5, color: "var(--signal)", background: "var(--signal-bg)",
                border: "1px solid var(--signal)", borderRadius: 8, padding: "8px 10px" }}>{error}</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 7, padding: "10px 12px", borderTop: "1px solid var(--line)" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
              placeholder={canWrite ? "Ask, or describe what to add…" : "Ask about the timetable…"}
              style={{ flex: 1, padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}
            />
            <button className="btn btn-primary" onClick={() => send(input)} disabled={busy || !input.trim()}>
              {busy ? "…" : "Ask"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const chip: React.CSSProperties = {
  border: "1px solid var(--line)", background: "var(--paper)", borderRadius: 8,
  padding: "7px 11px", fontSize: 12.5, cursor: "pointer", textAlign: "left",
};
