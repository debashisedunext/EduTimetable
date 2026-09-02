/**
 * §13.4/§13.5 — one chat connection, two surfaces.
 *
 * The Ask AI screen and the floating dock are the same conversation with the
 * same tools; only the frame differs. Extracted so they cannot drift — a socket
 * event handled in one and forgotten in the other is exactly the bug that would
 * make the dock quietly miss a drafted proposal.
 */
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getToken } from "../api";
import type { Proposal } from "./ProposalCard";

export interface ToolTrace { name: string; args: Record<string, unknown>; ok: boolean; summary: string }
export interface ReportCard { title: string; reportType: string; format: string; downloadPath: string }

export interface Msg {
  role: "user" | "ai";
  text: string;
  tools?: ToolTrace[];
  cards?: ReportCard[];
  /** §13.5 — drafted rows awaiting a human Apply */
  proposals?: Proposal[];
  at: Date;
  streaming?: boolean;
}

export function useAiChat(scopeId: number | null) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  /** Fold something into the message currently streaming. */
  const intoLast = (fn: (m: Msg) => Msg) =>
    setMessages((all) => {
      const next = [...all];
      const last = next[next.length - 1];
      if (last?.role === "ai") next[next.length - 1] = fn(last);
      return next;
    });

  useEffect(() => {
    const socket = io("/ai", { auth: { token: getToken() } });
    socketRef.current = socket;

    socket.on("ai:start", (d: { conversationId: string }) => {
      setConversationId(d.conversationId);
      setMessages((m) => [...m, { role: "ai", text: "", at: new Date(), streaming: true, tools: [], cards: [], proposals: [] }]);
    });
    socket.on("ai:delta", (d: { text: string }) => intoLast((l) => ({ ...l, text: l.text + d.text })));
    socket.on("ai:tool", (t: ToolTrace) => intoLast((l) => ({ ...l, tools: [...(l.tools ?? []), t] })));
    socket.on("ai:card", (d: { card: ReportCard }) => intoLast((l) => ({ ...l, cards: [...(l.cards ?? []), d.card] })));
    socket.on("ai:proposal", (d: { proposal: Proposal }) =>
      intoLast((l) => ({ ...l, proposals: [...(l.proposals ?? []), d.proposal] })));

    socket.on("ai:done", () => {
      setBusy(false);
      intoLast((l) => ({
        ...l,
        streaming: false,
        // A turn that finished with nothing to say must not leave a silent
        // blank bubble — that reads as "broken" with no way to tell why. A
        // drafted proposal is an answer in itself, so it is not empty.
        text: l.text.trim() || ((l.proposals ?? []).length > 0
          ? ""
          : "The assistant finished without an answer. This usually means the model used its whole output budget; try a shorter question, or a lighter model on AI Settings."),
      }));
    });
    socket.on("ai:error", (d: { message: string }) => {
      setBusy(false);
      setError(d.message);
      setMessages((m) => m.filter((x) => !(x.role === "ai" && x.streaming && !x.text)));
    });
    socket.on("disconnect", () => setBusy(false));
    return () => { socket.disconnect(); };
  }, []);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy || !socketRef.current) return;
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: q, at: new Date() }]);
    socketRef.current.emit("ai:ask", { question: q, conversationId, timetableConfigId: scopeId });
  };

  const reset = () => {
    setMessages([]);
    setConversationId(null);
    setError(null);
  };

  return { messages, setMessages, busy, error, setError, ask, reset, conversationId };
}
