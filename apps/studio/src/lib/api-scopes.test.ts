import { describe, expect, it } from "vitest";
import { API_SCOPES } from "@uniora/core";
import { API_SCOPE_META } from "@/lib/api-scopes";

describe("API_SCOPE_META", () => {
  it("is exactly the scope list of Core, including which scopes are sensitive", () => {
    expect(Object.fromEntries(Object.entries(API_SCOPE_META).map(([scope, meta]) => [scope, meta.sensitive]))).toEqual(
      Object.fromEntries(Object.entries(API_SCOPES).map(([scope, meta]) => [scope, meta.sensitive])),
    );
  });
});
