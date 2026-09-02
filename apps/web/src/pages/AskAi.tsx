import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { getToken } from "../api";
import { Card } from "../components";
import { useConfigCtx } from "../hooks";
import { Markdown } from "../markdown";
import { ProposalCard, type Proposal } from "../ai/ProposalCard";

interface ToolTrace { name: string; args: Record<string, unknown>; ok: boolean; summary: string }
interface ReportCard { title: string; reportType: string; format: string; downloadPath: string }
interface Msg {
  role: "user" | "ai";
  text: string;
  tools?: ToolTrace[];
  cards?: ReportCard[];
  /** §13.5 — drafted master-data rows awaiting a human Apply */
  proposals?: Proposal[];
  at: Date;
  streaming?: boolean;
}

const SUGGESTIONS = [
  "What is Rekha Sharma's load this week?",
  "Which teachers are free Friday period 6?",
  "Which room is most underused?",
  "Why is generation blocked right now?",
  "Show me Class 5-A's timetable",
];

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Screen 11 (§13.4) — Ask AI: streaming answers, collapsible tool traces,
 *  report cards, suggestion chips, scope selector, read-only notice. */
export function AskAi() {
  const { configs, current } = useConfigCtx();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState<number | null>(current?.id ?? null);
  const [openTrace, setOpenTrace] = useState<Record<string, boolean>>({});
  const socketRef = useRef<Socket | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (current && scopeId === null) setScopeId(current.id); }, [current, scopeId]);

  useEffect(() => {
    const socket = io("/ai", { auth: { token: getToken() } });
    socketRef.current = socket;

    socket.on("ai:start", (d: { conversationId: string }) => {
      setConversationId(d.conversationId);
      setMessages((m) => [...m, { role: "ai", text: "", at: new Date(), streaming: true, tools: [], cards: [] }]);
    });
    socket.on("ai:delta", (d: { text: string }) => {
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "ai") next[next.length - 1] = { ...last, text: last.text + d.text };
        return next;
      });
    });
    socket.on("ai:tool", (t: ToolTrace) => {
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "ai") next[next.length - 1] = { ...last, tools: [...(last.tools ?? []), t] };
        return next;
      });
    });
    socket.on("ai:proposal", (d: { proposal: Proposal }) => {
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "ai") next[next.length - 1] = { ...last, proposals: [...(last.proposals ?? []), d.proposal] };
        return next;
      });
    });
    socket.on("ai:card", (d: { card: ReportCard }) => {
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "ai") next[next.length - 1] = { ...last, cards: [...(last.cards ?? []), d.card] };
        return next;
      });
    });
    socket.on("ai:done", () => {
      setBusy(false);
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "ai") {
          // A turn that finished with nothing to say must not leave a silent
          // blank bubble — that reads as "broken" with no way to tell why.
          next[next.length - 1] = {
            ...last,
            streaming: false,
            text: last.text.trim()
              ? last.text
              : (last.proposals ?? []).length > 0
                ? ""
                : "The assistant finished without an answer. This usually means the model used its whole output budget; try a shorter question, or a lighter model on AI Settings.",
          };
        }
        return next;
      });
    });
    socket.on("ai:error", (d: { message: string }) => {
      setBusy(false);
      setError(d.message);
      setMessages((m) => m.filter((x) => !(x.role === "ai" && x.streaming && !x.text)));
    });
    socket.on("disconnect", () => setBusy(false));
    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy || !socketRef.current) return;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q, at: new Date() }]);
    socketRef.current.emit("ai:ask", { question: q, conversationId, timetableConfigId: scopeId });
  };

  const scopeName = useMemo(
    () => configs.find((c) => c.id === scopeId)?.name ?? "no timetable selected",
    [configs, scopeId],
  );

  return (
    <div className="ai-layout">
      <div className="card chat-card">
        <div className="chat-head">
          <div className="ai-avatar">✦</div>
          <div style={{ flex: 1 }}>
            <div className="chat-head-name">Timetable Assistant</div>
            <div className="chat-head-sub">Answers only from this school's data · scope: {scopeName}</div>
          </div>
          {/* Accurate for both roles since §13.5: the assistant still cannot
              touch a lesson, and master data it drafts is written only by a
              human pressing Apply. */}
          <span className="readonly-pill">🔒 never changes the timetable · new master data needs your approval</span>
        </div>

        <div className="chat-body" ref={bodyRef}>
          {messages.length === 0 && (
            <div className="msg ai">
              <div className="bubble">
                Ask me about teacher load, free periods, room use, substitutions, or why generation is blocked.
                I answer only from this school's timetable — and I'll show you exactly which queries I ran.
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.tools && m.tools.length > 0 && (
                <button className={`tool-trace${m.tools.some((t) => !t.ok) ? " err" : ""}`}
                  onClick={() => setOpenTrace((o) => ({ ...o, [i]: !o[i] }))}>
                  🔎 queried: {m.tools.map((t) => t.name).join(", ")} {openTrace[i] ? "▾" : "▸"}
                </button>
              )}
              {openTrace[i] && m.tools && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, background: "var(--brand-deep)", color: "var(--steel-light)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6, maxWidth: "100%", overflowX: "auto" }}>
                  {m.tools.map((t, j) => (
                    <div key={j}>
                      {t.ok ? "✓" : "✗"} {t.name}({JSON.stringify(t.args)}) → {t.summary}
                    </div>
                  ))}
                </div>
              )}
              {/* The assistant answers in Markdown — tables above all, since a
                  class's week or a teacher's load IS a table. The user's own
                  message is their literal text and stays unparsed. */}
              {(m.text || !m.streaming) && (
                <div className="bubble">
                  {m.role === "ai" ? <Markdown text={m.text} /> : m.text}
                </div>
              )}
              {m.streaming && !m.text && (
                <div className="bubble typing"><span /><span /><span /></div>
              )}
              {m.proposals?.map((p, j) => (
                <ProposalCard key={`p${j}`} proposal={p} onApplied={() => { /* the card owns its own applied state */ }} />
              ))}
              {m.cards?.map((c, j) => (
                <div key={j} className="report-chip">
                  <div className="report-chip-icon">{c.format.toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    <div className="report-chip-name">{c.title}</div>
                    <div className="report-chip-meta">Generated by the standard Reports pipeline</div>
                  </div>
                  <Link to={c.downloadPath} className="btn btn-primary" style={{ textDecoration: "none", padding: "6px 12px", fontSize: 12 }}>
                    Open →
                  </Link>
                </div>
              ))}
              <div className="msg-time">{time(m.at)}</div>
            </div>
          ))}
          {error && (
            <div className="msg ai">
              <div className="bubble" style={{ borderColor: "var(--signal)", background: "var(--signal-bg)", color: "var(--signal)" }}>
                {error}
              </div>
            </div>
          )}
        </div>

        <div className="suggest-row">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggest-chip" onClick={() => ask(s)} disabled={busy}>{s}</button>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            placeholder="Ask about load, availability, rooms, substitutions…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(input); }}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={() => ask(input)} disabled={busy || !input.trim()}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>
      </div>

      <div className="ai-rail">
        <Card title="Conversation scope">
          <select value={scopeId ?? ""} onChange={(e) => setScopeId(Number(e.target.value) || null)}
            style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5, fontWeight: 600 }}>
            <option value="">— no timetable —</option>
            {configs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <p className="ai-scope-note" style={{ marginTop: 10 }}>
            Questions without an explicit timetable are answered about <b>{scopeName}</b>.
          </p>
        </Card>

        <Card title="How it answers">
          <p className="ai-scope-note">
            The assistant can only call a <b>fixed list of read-only queries</b> — the same ones behind the Reports
            screen. It cannot write SQL, see other schools, or place a single period.
            Your <b>school and view scope are attached server-side</b> to every query, so no phrasing can widen them.
            Every answer shows the queries it ran; if the data isn't there, it says so instead of guessing.
          </p>
        </Card>

        <Card title="New conversation">
          <button className="btn btn-secondary" style={{ width: "100%" }}
            onClick={() => { setMessages([]); setConversationId(null); setError(null); }}>
            Start fresh
          </button>
        </Card>
      </div>
    </div>
  );
}
