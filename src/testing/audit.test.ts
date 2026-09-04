import { describe, expect, it } from "vitest";

import { defineTenancy } from "../tenancy.js";
import { assertTenancy, auditTenancy, formatFindings } from "./audit.js";

const SCHEMA = `
model Organization {
  id String @id
}

model Venue {
  id             String @id
  organizationId String
  orders         Order[]
}

model Order {
  id      String @id
  venueId String
  items   OrderItem[]
}

model OrderItem {
  id      String @id
  orderId String
  order   Order  @relation(fields: [orderId], references: [id])
  modifiers OrderItemModifier[]
}

model OrderItemModifier {
  id          String    @id
  orderItemId String
  orderItem   OrderItem @relation(fields: [orderItemId], references: [id])
}

model User {
  id String @id
}
`;

function tenancy(overrides: Record<string, unknown> = {}) {
  return defineTenancy({
    scopes: {
      organization: { column: "organizationId" },
      venue: { column: "venueId" },
    },
    models: { Venue: "organization", Order: "venue" },
    children: {
      OrderItem: { path: ["order"], through: "Order" },
      OrderItemModifier: { path: ["orderItem", "order"], through: "Order" },
    },
    global: ["User", "Organization"],
    ...overrides,
  });
}

describe("auditTenancy", () => {
  it("passes a registry that matches the schema", () => {
    expect(auditTenancy(tenancy(), { schema: SCHEMA })).toEqual([]);
  });

  it("catches a model the schema has and nobody classified", () => {
    const incomplete = tenancy({ global: ["User"] });

    expect(auditTenancy(incomplete, { schema: SCHEMA })).toEqual([
      { kind: "unclassified", model: "Organization" },
    ]);
  });

  it("catches a classification the schema no longer has", () => {
    const stale = tenancy({
      models: { Venue: "organization", Order: "venue", Ghost: "venue" },
    });

    expect(auditTenancy(stale, { schema: SCHEMA })).toContainEqual({
      kind: "stale",
      model: "Ghost",
    });
  });

  it("catches a tenant model with no scope column", () => {
    const wrong = defineTenancy({
      scopes: { venue: { column: "venueId" } },
      models: { Venue: "venue", Order: "venue" },
      global: ["User", "Organization", "OrderItem", "OrderItemModifier"],
    });

    expect(auditTenancy(wrong, { schema: SCHEMA })).toEqual([
      { kind: "missing-column", model: "Venue", column: "venueId" },
    ]);
  });

  it("catches a child routed through a relation that does not exist", () => {
    const wrong = tenancy({
      children: { OrderItem: { path: ["cart"], through: "Order" } },
      global: ["User", "Organization", "OrderItemModifier"],
    });

    expect(auditTenancy(wrong, { schema: SCHEMA })).toEqual([
      {
        kind: "unknown-relation",
        model: "OrderItem",
        on: "OrderItem",
        relation: "cart",
      },
    ]);
  });

  it("catches a child routed through a list instead of a parent", () => {
    const wrong = tenancy({
      children: { OrderItem: { path: ["modifiers"], through: "Order" } },
      global: ["User", "Organization", "OrderItemModifier"],
    });

    expect(auditTenancy(wrong, { schema: SCHEMA })).toEqual([
      {
        kind: "list-relation",
        model: "OrderItem",
        on: "OrderItem",
        relation: "modifiers",
      },
    ]);
  });

  it("catches a path that ends somewhere other than the model it claims", () => {
    const wrong = tenancy({
      children: {
        OrderItem: { path: ["order"], through: "Order" },
        OrderItemModifier: { path: ["orderItem"], through: "Order" },
      },
    });

    expect(auditTenancy(wrong, { schema: SCHEMA })).toEqual([
      {
        kind: "wrong-terminus",
        model: "OrderItemModifier",
        expected: "Order",
        actual: "OrderItem",
      },
    ]);
  });

  it("takes the model list from the client when one is given", () => {
    expect(
      auditTenancy(tenancy(), {
        schema: SCHEMA,
        models: [
          "Organization",
          "Venue",
          "Order",
          "OrderItem",
          "OrderItemModifier",
          "User",
          "Payment",
        ],
      }),
    ).toEqual([{ kind: "unclassified", model: "Payment" }]);
  });

  it("throws a readable message when asserting a broken registry", () => {
    expect(() =>
      assertTenancy(tenancy({ global: ["User"] }), { schema: SCHEMA }),
    ).toThrow(/Organization is in the schema but is not classified/);
  });

  it("says nothing when asserting a sound registry", () => {
    expect(() => assertTenancy(tenancy(), { schema: SCHEMA })).not.toThrow();
  });

  it("writes one line per finding", () => {
    expect(
      formatFindings([
        { kind: "unclassified", model: "Payment" },
        { kind: "stale", model: "Ghost" },
      ]).split("\n"),
    ).toHaveLength(2);
  });
});
