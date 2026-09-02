import { describe, expect, it } from "vitest";
import { fillTemplate, mapRecord, missingFields, pick, pickList } from "./json-map";

describe("§23.6 pick — reading a path out of an ERP's JSON", () => {
  const body = {
    data: [{ staff_code: "E-1", profile: { full_name: "Aditi Verma", active: 1 } }],
    meta: { last_page: 3 },
  };

  it("reads nested paths, in both notations somebody might type", () => {
    expect(pick(body, "data.0.staff_code")).toBe("E-1");
    expect(pick(body, "data[0].profile.full_name")).toBe("Aditi Verma");
    expect(pick(body, "meta.last_page")).toBe(3);
  });

  it("returns the whole value for an empty path", () => {
    expect(pick(body, "")).toBe(body);
  });

  it("returns undefined rather than throwing on a path that does not resolve", () => {
    // Load-bearing: the reconcile engine treats undefined as "this source does
    // not carry the field", and leaves ours alone.
    expect(pick(body, "data.0.nope")).toBeUndefined();
    expect(pick(body, "data.9.staff_code")).toBeUndefined();
    expect(pick(body, "meta.last_page.deeper")).toBeUndefined();
    expect(pick(null, "a.b")).toBeUndefined();
  });

  it("keeps null distinct from missing", () => {
    // null is a real value the ERP sent; missing is a field it does not have.
    expect(pick({ a: null }, "a")).toBeNull();
    expect(pick({ a: null }, "b")).toBeUndefined();
  });
});

describe("§23.6 pickList — where the records live", () => {
  it("takes the response root when no path is given", () => {
    expect(pickList([{ a: 1 }], "")).toHaveLength(1);
  });

  it("takes a nested list", () => {
    expect(pickList({ result: { items: [1, 2] } }, "result.items")).toEqual([1, 2]);
  });

  it("throws rather than reporting a wrong path as an empty result", () => {
    // "0 rows" would send somebody hunting for missing data in the ERP.
    expect(() => pickList({ data: { items: [] } }, "data")).toThrow(/expected a list/);
    expect(() => pickList({}, "nope")).toThrow(/found nothing/);
  });
});

describe("§23.6 mapRecord — the ERP's shape to ours", () => {
  const fields = { employeeCode: "staff_code", name: "profile.full_name", isActive: "profile.active" };

  it("maps declared paths onto our field keys", () => {
    const rec = { staff_code: " E-1 ", profile: { full_name: "Aditi Verma", active: 1 } };
    expect(mapRecord(rec, fields)).toEqual({ employeeCode: "E-1", name: "Aditi Verma", isActive: 1 });
  });

  it("OMITS a field the path did not find, rather than nulling it", () => {
    // A partial API must not be data loss.
    const rec = { staff_code: "E-1", profile: { full_name: "Aditi Verma" } };
    const mapped = mapRecord(rec, fields);
    expect("isActive" in mapped).toBe(false);
  });

  it("names what a mapping failed to produce, and where it looked", () => {
    const rec = { staff_code: "E-1" };
    expect(missingFields(rec, fields)).toEqual([
      'name (no "profile.full_name" in the response)',
      'isActive (no "profile.active" in the response)',
    ]);
  });
});

describe("§23.6 fillTemplate — building the request URL", () => {
  it("substitutes and URL-encodes", () => {
    expect(fillTemplate("/staff?school={schoolId}&page={page}", { schoolId: "A/B", page: 2 }))
      .toBe("/staff?school=A%2FB&page=2");
  });

  it("refuses an unknown placeholder instead of sending it literally", () => {
    // `{schoolId}` reaching an ERP as a string would 404 — or, worse, be
    // ignored and return every school's staff.
    expect(() => fillTemplate("/staff?s={nope}", { schoolId: 1 })).toThrow(/unknown placeholder/);
  });

  it("leaves a template with no placeholders alone", () => {
    expect(fillTemplate("/subjects", {})).toBe("/subjects");
  });
});
