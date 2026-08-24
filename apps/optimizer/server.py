"""
Phase 6 (§5.6) — OR-Tools CP-SAT optimizer microservice.

Contract: POST /solve with the CpSatModel JSON built by
packages/shared/src/optimize/model.ts, get back {status, assignments[]}.

Division of labour (see model.ts): TypeScript owns §4.7 domain pruning and
room assignment; this service owns search plus the three §5.6 soft objectives
(teacher gaps, peak daily load, room changes). Every answer is re-verified by
the TypeScript ConstraintChecker before it can reach the database, so this
service is never trusted for hard-constraint correctness.

Stdlib HTTP only — ortools is the single dependency.
"""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ortools.sat.python import cp_model

logging.basicConfig(level=logging.INFO, format="[optimizer] %(message)s")
log = logging.getLogger("optimizer")

MAX_BODY_BYTES = 32 * 1024 * 1024


def solve(model_json: dict[str, Any]) -> dict[str, Any]:
    periods_per_day: int = model_json["periodsPerDay"]
    days: list[int] = model_json["workingDays"]
    variables: list[dict[str, Any]] = model_json["variables"]
    teacher_day_cap: dict[str, int] = model_json["teacherDayCap"]
    subject_day_cap: dict[str, int] = model_json["subjectDayCap"]
    alternate_period_teachers = set(model_json.get("alternatePeriodTeachers", []))
    lab_capacity: dict[str, int] = model_json.get("labCapacity", {})
    weights: dict[str, int] = model_json.get("weights", {})
    time_limit: float = float(model_json.get("timeLimitSec", 30))

    m = cp_model.CpModel()

    # ---- decision variables: one bool per (variable, legal start cell) ----
    # x[(vid, day, period)] == 1  ->  that occurrence starts there
    x: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for v in variables:
        vid = v["id"]
        lits = []
        for day, period in v["domain"]:
            lit = m.NewBoolVar(f"x_{vid}_{day}_{period}")
            x[(vid, day, period)] = lit
            lits.append(lit)
        if not lits:
            # no legal cell at all — infeasible by construction, report cleanly
            return {"status": "INFEASIBLE_EMPTY_DOMAIN", "assignments": [], "variableId": vid}
        m.AddExactlyOne(lits)

    # literals occupying a given cell, grouped by the dimension they contend on
    section_cell: dict[tuple[int, int, int], list[cp_model.IntVar]] = {}
    teacher_cell: dict[tuple[int, int, int], list[cp_model.IntVar]] = {}
    room_cell: dict[tuple[int, int, int], list[cp_model.IntVar]] = {}
    lab_cell: dict[tuple[int, int], list[cp_model.IntVar]] = {}
    teacher_day_lits: dict[tuple[int, int], list[tuple[cp_model.IntVar, int]]] = {}
    subject_day_lits: dict[tuple[str, int], list[tuple[cp_model.IntVar, int]]] = {}
    same_period_groups: dict[str, list[tuple[cp_model.IntVar, int]]] = {}

    for v in variables:
        vid, span = v["id"], v["span"]
        for day, period in v["domain"]:
            lit = x[(vid, day, period)]
            for s in range(span):
                p = period + s
                for cs in v["classSectionIds"]:
                    section_cell.setdefault((cs, day, p), []).append(lit)
                teacher_cell.setdefault((v["teacherId"], day, p), []).append(lit)
                if v["preferredRoomId"] is not None:
                    room_cell.setdefault((v["preferredRoomId"], day, p), []).append(lit)
                elif v["needsLabRoom"]:
                    lab_cell.setdefault((day, p), []).append(lit)
            teacher_day_lits.setdefault((v["teacherId"], day), []).append((lit, span))
            for key in v["subjectDayKeys"]:
                subject_day_lits.setdefault((key, day), []).append((lit, span))
            if v["samePeriodKey"]:
                same_period_groups.setdefault(v["samePeriodKey"], []).append((lit, period))

    # ---- hard constraints (mirrors of the §5.1 checks) ----
    for lits in section_cell.values():
        if len(lits) > 1:
            m.AddAtMostOne(lits)
    for lits in teacher_cell.values():
        if len(lits) > 1:
            m.AddAtMostOne(lits)
    for lits in room_cell.values():
        if len(lits) > 1:
            m.AddAtMostOne(lits)
    for (day, p), lits in lab_cell.items():
        cap = lab_capacity.get(f"{day}:{p}", 0)
        if len(lits) > cap:
            m.Add(sum(lits) <= cap)

    for (teacher_id, day), pairs in teacher_day_lits.items():
        cap = teacher_day_cap.get(f"{teacher_id}@{day}", periods_per_day)
        m.Add(sum(lit * span for lit, span in pairs) <= cap)

    for (key, day), pairs in subject_day_lits.items():
        cap = subject_day_cap.get(f"{key}@{day}", periods_per_day)
        m.Add(sum(lit * span for lit, span in pairs) <= cap)

    # §4.6 same subject, same period every day it occurs
    for key, pairs in same_period_groups.items():
        by_period: dict[int, list[cp_model.IntVar]] = {}
        for lit, period in pairs:
            by_period.setdefault(period, []).append(lit)
        chosen = {p: m.NewBoolVar(f"sp_{key}_{p}") for p in by_period}
        m.AddExactlyOne(list(chosen.values()))
        for p, lits in by_period.items():
            for lit in lits:
                m.AddImplication(lit, chosen[p])

    # §4.7 alternate-period teachers: never two adjacent periods on a day
    for teacher_id in alternate_period_teachers:
        for day in days:
            for p in range(1, periods_per_day):
                a = teacher_cell.get((teacher_id, day, p), [])
                b = teacher_cell.get((teacher_id, day, p + 1), [])
                if a and b:
                    m.Add(sum(a) + sum(b) <= 1)

    # ---- soft objectives (§5.6) ----
    terms: list[cp_model.LinearExpr] = []
    w_gaps = int(weights.get("teacherGaps", 0))
    w_load = int(weights.get("dailyLoadBalance", 0))
    w_rooms = int(weights.get("roomChanges", 0))

    teacher_ids = {v["teacherId"] for v in variables}

    # busy[t][day][p] — reused by both the gap and load terms
    busy: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for t in teacher_ids:
        for day in days:
            for p in range(1, periods_per_day + 1):
                lits = teacher_cell.get((t, day, p), [])
                b = m.NewBoolVar(f"busy_{t}_{day}_{p}")
                if lits:
                    m.Add(sum(lits) == 1).OnlyEnforceIf(b)
                    m.Add(sum(lits) == 0).OnlyEnforceIf(b.Not())
                else:
                    m.Add(b == 0)
                busy[(t, day, p)] = b

    if w_gaps > 0:
        # a gap = free period with teaching both before and after it that day
        for t in teacher_ids:
            for day in days:
                for p in range(2, periods_per_day):
                    before = [busy[(t, day, q)] for q in range(1, p)]
                    after = [busy[(t, day, q)] for q in range(p + 1, periods_per_day + 1)]
                    if not before or not after:
                        continue
                    has_before = m.NewBoolVar(f"bef_{t}_{day}_{p}")
                    m.AddMaxEquality(has_before, before)
                    has_after = m.NewBoolVar(f"aft_{t}_{day}_{p}")
                    m.AddMaxEquality(has_after, after)
                    gap = m.NewBoolVar(f"gap_{t}_{day}_{p}")
                    m.AddBoolAnd([has_before, has_after, busy[(t, day, p)].Not()]).OnlyEnforceIf(gap)
                    m.AddBoolOr([has_before.Not(), has_after.Not(), busy[(t, day, p)]]).OnlyEnforceIf(gap.Not())
                    terms.append(w_gaps * gap)

    if w_load > 0:
        # peak daily load per teacher — minimising the peak flattens the week
        for t in teacher_ids:
            peak = m.NewIntVar(0, periods_per_day, f"peak_{t}")
            for day in days:
                pairs = teacher_day_lits.get((t, day), [])
                if pairs:
                    m.Add(sum(lit * span for lit, span in pairs) <= peak)
            terms.append(w_load * peak)

    if w_rooms > 0:
        # lab↔classroom switches between consecutive periods for a section-day
        sections = {cs for v in variables for cs in v["classSectionIds"]}
        lab_by_section_cell: dict[tuple[int, int, int], list[cp_model.IntVar]] = {}
        for v in variables:
            if not v["needsLabRoom"]:
                continue
            for day, period in v["domain"]:
                lit = x[(v["id"], day, period)]
                for s in range(v["span"]):
                    for cs in v["classSectionIds"]:
                        lab_by_section_cell.setdefault((cs, day, period + s), []).append(lit)
        for cs in sections:
            for day in days:
                lab_at: dict[int, cp_model.IntVar] = {}
                for p in range(1, periods_per_day + 1):
                    lits = lab_by_section_cell.get((cs, day, p), [])
                    b = m.NewBoolVar(f"lab_{cs}_{day}_{p}")
                    if lits:
                        m.AddMaxEquality(b, lits)
                    else:
                        m.Add(b == 0)
                    lab_at[p] = b
                for p in range(1, periods_per_day):
                    switch = m.NewBoolVar(f"sw_{cs}_{day}_{p}")
                    # switch == XOR(lab_at[p], lab_at[p+1])
                    m.Add(lab_at[p] + lab_at[p + 1] == 1).OnlyEnforceIf(switch)
                    m.Add(lab_at[p] + lab_at[p + 1] != 1).OnlyEnforceIf(switch.Not())
                    terms.append(w_rooms * switch)

    if terms:
        m.Minimize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = int(os.environ.get("CPSAT_WORKERS", "8"))
    status = solver.Solve(m)
    status_name = solver.StatusName(status)

    assignments = []
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for v in variables:
            vid = v["id"]
            for day, period in v["domain"]:
                if solver.Value(x[(vid, day, period)]):
                    assignments.append({"variableId": vid, "day": day, "period": period})
                    break

    log.info(
        "solve: %s vars=%d status=%s objective=%s wall=%.2fs",
        model_json.get("label", ""),
        len(variables),
        status_name,
        solver.ObjectiveValue() if terms and assignments else None,
        solver.WallTime(),
    )
    return {
        "status": status_name,
        "assignments": assignments,
        "objective": solver.ObjectiveValue() if terms and assignments else None,
        "wallTimeSec": solver.WallTime(),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "service": "cpsat-optimizer"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/solve":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "bad content length"})
            return
        try:
            model_json = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return
        try:
            self._send(200, solve(model_json))
        except Exception as e:  # noqa: BLE001 — never take the service down
            log.exception("solve failed")
            self._send(500, {"error": str(e), "status": "ERROR", "assignments": []})

    def log_message(self, *args: Any) -> None:  # quieter default access log
        return


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    log.info("CP-SAT optimizer listening on :%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
