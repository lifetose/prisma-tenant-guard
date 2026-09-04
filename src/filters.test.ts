import { describe, expect, it } from "vitest";

import { TenantMismatchError } from "./errors.js";
import {
  assertDataKeepsTenant,
  mergeChildWhere,
  mergeTenantWhere,
  stampTenantData,
} from "./filters.js";

describe("mergeTenantWhere", () => {
  it("adds the tenant condition to an absent where", () => {
    expect(mergeTenantWhere("Order", undefined, "venueId", "v1")).toEqual({
      venueId: "v1",
    });
  });

  it("leaves the caller's own conditions in place", () => {
    expect(
      mergeTenantWhere("Order", { status: "PAID" }, "venueId", "v1"),
    ).toEqual({
      status: "PAID",
      venueId: "v1",
    });
  });

  it("accepts a where that names the same tenant", () => {
    expect(
      mergeTenantWhere("Order", { venueId: "v1" }, "venueId", "v1"),
    ).toEqual({
      venueId: "v1",
    });
  });

  it("accepts an equals wrapper naming the same tenant", () => {
    expect(
      mergeTenantWhere("Order", { venueId: { equals: "v1" } }, "venueId", "v1"),
    ).toEqual({ venueId: "v1" });
  });

  it("refuses a where that names another tenant", () => {
    expect(() =>
      mergeTenantWhere("Order", { venueId: "v2" }, "venueId", "v1"),
    ).toThrow(TenantMismatchError);
  });

  it("refuses a set of tenants rather than narrowing it", () => {
    expect(() =>
      mergeTenantWhere(
        "Order",
        { venueId: { in: ["v1", "v2"] } },
        "venueId",
        "v1",
      ),
    ).toThrow(TenantMismatchError);
  });
});

describe("stampTenantData", () => {
  it("stamps a single record", () => {
    expect(
      stampTenantData("Order", { total: 1 }, "venueId", "v1", "throw"),
    ).toEqual({
      total: 1,
      venueId: "v1",
    });
  });

  it("stamps every record of an array", () => {
    expect(
      stampTenantData(
        "Order",
        [{ total: 1 }, { total: 2 }],
        "venueId",
        "v1",
        "throw",
      ),
    ).toEqual([
      { total: 1, venueId: "v1" },
      { total: 2, venueId: "v1" },
    ]);
  });

  it("refuses a record that names another tenant", () => {
    expect(() =>
      stampTenantData("Order", { venueId: "v2" }, "venueId", "v1", "throw"),
    ).toThrow(TenantMismatchError);
  });

  it("refuses one bad record inside an array", () => {
    expect(() =>
      stampTenantData(
        "Order",
        [{ total: 1 }, { venueId: "v2" }],
        "venueId",
        "v1",
        "throw",
      ),
    ).toThrow(TenantMismatchError);
  });

  it("overwrites a foreign tenant when the policy says so", () => {
    expect(
      stampTenantData("Order", { venueId: "v2" }, "venueId", "v1", "overwrite"),
    ).toEqual({ venueId: "v1" });
  });
});

describe("assertDataKeepsTenant", () => {
  it("passes when the update does not touch the column", () => {
    expect(() =>
      assertDataKeepsTenant("Order", { total: 1 }, "venueId", "v1"),
    ).not.toThrow();
  });

  it("passes when the update rewrites the column to the same tenant", () => {
    expect(() =>
      assertDataKeepsTenant(
        "Order",
        { venueId: { set: "v1" } },
        "venueId",
        "v1",
      ),
    ).not.toThrow();
  });

  it("refuses an update that moves the row", () => {
    expect(() =>
      assertDataKeepsTenant(
        "Order",
        { venueId: { set: "v2" } },
        "venueId",
        "v1",
      ),
    ).toThrow(TenantMismatchError);
  });
});

describe("mergeChildWhere", () => {
  it("keeps the caller's conditions beside the nested filter", () => {
    expect(mergeChildWhere({ id: "x" }, { order: { venueId: "v1" } })).toEqual({
      id: "x",
      order: { venueId: "v1" },
    });
  });
});
