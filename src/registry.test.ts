import { describe, expect, it } from "vitest";

import { TenancyConfigError } from "./errors.js";
import {
  childTenantFilter,
  delegateKey,
  nestThroughPath,
  TenancyRegistry,
} from "./registry.js";
import type { TenancyConfig } from "./types.js";

const config: TenancyConfig = {
  scopes: {
    organization: { column: "organizationId" },
    venue: { column: "venueId" },
  },
  models: { Venue: "organization", Order: "venue" },
  children: {
    OrderItem: { path: ["order"], through: "Order" },
    OrderItemModifier: { path: ["orderItem", "order"], through: "Order" },
  },
  global: ["User"],
};

describe("TenancyRegistry", () => {
  it("resolves a tenant model to its scope column", () => {
    const registry = new TenancyRegistry(config);

    expect(registry.tenantEntry("Order")).toEqual({
      model: "Order",
      scope: "venue",
      column: "venueId",
    });
  });

  it("inherits the scope of the model a child routes through", () => {
    const registry = new TenancyRegistry(config);

    expect(registry.childEntry("OrderItemModifier")).toEqual({
      model: "OrderItemModifier",
      path: ["orderItem", "order"],
      through: "Order",
      scope: "venue",
      column: "venueId",
    });
  });

  it("classifies every declared model exactly once", () => {
    const registry = new TenancyRegistry(config);

    expect(registry.classify("Venue")).toBe("tenant");
    expect(registry.classify("OrderItem")).toBe("child");
    expect(registry.classify("User")).toBe("global");
    expect(registry.classify("Ghost")).toBeUndefined();
    expect(registry.classified()).toHaveLength(5);
  });

  it("refuses a model scoped to an undeclared scope", () => {
    expect(
      () =>
        new TenancyRegistry({
          scopes: { venue: { column: "venueId" } },
          models: { Order: "tenant" },
        }),
    ).toThrow(TenancyConfigError);
  });

  it("refuses a child routed through a model that is not tenant-scoped", () => {
    expect(
      () =>
        new TenancyRegistry({
          scopes: { venue: { column: "venueId" } },
          models: { Order: "venue" },
          children: { OrderItem: { path: ["cart"], through: "Cart" } },
        }),
    ).toThrow(/not a tenant-scoped model/);
  });

  it("refuses a model classified twice", () => {
    expect(
      () =>
        new TenancyRegistry({
          scopes: { venue: { column: "venueId" } },
          models: { Order: "venue" },
          global: ["Order"],
        }),
    ).toThrow(/both as global and as tenant-scoped/);
  });

  it("refuses a child with an empty path", () => {
    expect(
      () =>
        new TenancyRegistry({
          scopes: { venue: { column: "venueId" } },
          models: { Order: "venue" },
          children: { OrderItem: { path: [], through: "Order" } },
        }),
    ).toThrow(/empty path/);
  });

  it("refuses a tenancy with no scopes", () => {
    expect(() => new TenancyRegistry({ scopes: {}, models: {} })).toThrow(
      /at least one scope/,
    );
  });

  it("nests one level of filter per relation in the path", () => {
    expect(nestThroughPath(["order"], { venueId: "v1" })).toEqual({
      order: { venueId: "v1" },
    });

    expect(
      childTenantFilter(
        { path: ["orderItem", "order"], column: "venueId" },
        "v1",
      ),
    ).toEqual({ orderItem: { order: { venueId: "v1" } } });
  });

  it("lowercases only the first letter of a delegate name", () => {
    expect(delegateKey("OrderItem")).toBe("orderItem");
    expect(delegateKey("URL")).toBe("uRL");
  });
});
