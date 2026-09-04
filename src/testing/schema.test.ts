import { describe, expect, it } from "vitest";

import { parseSchema, relationTarget } from "./schema.js";

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// A place that sells things.
model Venue {
  id             String  @id @default(cuid())
  organizationId String
  slug           String  @unique
  orders         Order[]
}

model Order {
  id      String @id
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id])
  items   OrderItem[]

  @@index([venueId])
}

model OrderItem {
  id      String @id
  orderId String
  order   Order  @relation(fields: [orderId], references: [id])
  note    String? // the guest typed this
}

enum Status {
  OPEN
  CLOSED
}
`;

describe("parseSchema", () => {
  it("reads every model block", () => {
    expect([...parseSchema(SCHEMA).keys()]).toEqual([
      "Venue",
      "Order",
      "OrderItem",
    ]);
  });

  it("does not mistake a datasource or an enum for a model", () => {
    expect(parseSchema(SCHEMA).has("Status")).toBe(false);
  });

  it("records the type of each field", () => {
    const order = parseSchema(SCHEMA).get("Order");

    expect(order?.fields.get("venue")).toEqual({
      name: "venue",
      type: "Venue",
      isList: false,
      optional: false,
    });
  });

  it("marks list relations", () => {
    expect(parseSchema(SCHEMA).get("Venue")?.fields.get("orders")?.isList).toBe(
      true,
    );
  });

  it("marks optional fields", () => {
    expect(
      parseSchema(SCHEMA).get("OrderItem")?.fields.get("note")?.optional,
    ).toBe(true);
  });

  it("skips block attributes", () => {
    expect(parseSchema(SCHEMA).get("Order")?.fields.has("@@index")).toBe(false);
  });

  it("does not read a trailing comment as a field", () => {
    const fields = [
      ...(parseSchema(SCHEMA).get("OrderItem")?.fields.keys() ?? []),
    ];

    expect(fields).toEqual(["id", "orderId", "order", "note"]);
  });

  it("keeps a url that contains a double slash", () => {
    const schema = parseSchema(`
model Venue {
  id   String @id
  site String @default("https://example.test/x")
}
`);

    expect(schema.get("Venue")?.fields.get("site")?.type).toBe("String");
  });

  it("resolves a relation to the model it points at", () => {
    const schema = parseSchema(SCHEMA);

    expect(relationTarget(schema, "OrderItem", "order")).toBe("Order");
    expect(relationTarget(schema, "OrderItem", "ghost")).toBeUndefined();
    expect(relationTarget(schema, "Ghost", "order")).toBeUndefined();
  });
});
