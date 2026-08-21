import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@edutimetable/shared";
import { ScopeService } from "./scope.service";

const svc = new ScopeService();

describe("ScopeService.resolve (§15.3)", () => {
  it("view.all wins regardless of other permissions", async () => {
    const scope = await svc.resolve(
      [PERMISSIONS.TIMETABLE_VIEW_ALL, PERMISSIONS.TIMETABLE_VIEW_OWN],
      null,
    );
    expect(scope).toEqual({ level: "all" });
  });

  it("view.class resolves to the linked sections for a linked teacher", async () => {
    const scope = await svc.resolve([PERMISSIONS.TIMETABLE_VIEW_CLASS], 42);
    expect(scope).toEqual({ level: "class", teacherId: 42, classSectionIds: [] });
  });

  it("view.class with no teacher link degrades to none (unlinked login, §15.4)", async () => {
    const scope = await svc.resolve([PERMISSIONS.TIMETABLE_VIEW_CLASS], null);
    expect(scope).toEqual({ level: "none" });
  });

  it("view.own requires a teacher link", async () => {
    expect(await svc.resolve([PERMISSIONS.TIMETABLE_VIEW_OWN], 7)).toEqual({
      level: "own",
      teacherId: 7,
    });
    expect(await svc.resolve([PERMISSIONS.TIMETABLE_VIEW_OWN], null)).toEqual({
      level: "none",
    });
  });

  it("no view permission at all → none (403 on any timetable data request)", async () => {
    expect(await svc.resolve([PERMISSIONS.SUBSTITUTE_MANAGE], 7)).toEqual({ level: "none" });
  });
});
