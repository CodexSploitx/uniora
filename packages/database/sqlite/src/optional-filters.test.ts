import { describe, expect, it } from "vitest";
import { resolveOptionalFilters } from "./optional-filters.js";

describe("resolveOptionalFilters", () => {
  it("drops a group whose parameter is null and unwraps one that has a value", () => {
    const sql = "select 1 from t where (?1 is null or organization_id = ?1) and (?2 is null or id > ?2) order by id";
    expect(resolveOptionalFilters(sql, ["org", null])).toEqual({
      sql: "select 1 from t where (organization_id = ?1) and (?2 is null) order by id",
      used: [1, 2],
    });
    expect(resolveOptionalFilters(sql, [null, "x"]).sql).toBe("select 1 from t where (?1 is null) and (id > ?2) order by id");
  });

  it("keeps nested parentheses, several uses of one parameter and quoted text intact", () => {
    const sql = "where (?5 is null or (provider = ?5 and subject = ?6)) and status = 'a (b' and (?7 is null or lower(x) = ?7)";
    const resolved = resolveOptionalFilters(sql, [null, null, null, null, "p", "s", null]);
    expect(resolved.sql).toBe("where ((provider = ?5 and subject = ?6)) and status = 'a (b' and (?7 is null)");
    expect(resolved.used).toEqual([5, 6, 7]);
  });

  it("resolves groups inside groups and leaves other statements untouched", () => {
    expect(resolveOptionalFilters("(?1 is null or (?2 is null or a = ?2))", [1, null]).sql).toBe("((?2 is null))");
    const plain = "select * from t where a = ?1 and b is null";
    expect(resolveOptionalFilters(plain, ["x"])).toEqual({ sql: plain, used: [1] });
  });
});
