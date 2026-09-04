import { beforeEach, describe, expect, it } from "vitest";

import { delegateKey } from "../registry.js";
import { defineTenancy } from "../tenancy.js";
import type { UnknownRecord } from "../types.js";
import { checkIsolation, formatIsolationFailures } from "./isolation.js";

interface Relation {
  model: string;
  foreignKey: string;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  Order: { venue: { model: "Venue", foreignKey: "venueId" } },
  OrderItem: { order: { model: "Order", foreignKey: "orderId" } },
  OrderItemModifier: {
    orderItem: { model: "OrderItem", foreignKey: "orderItemId" },
  },
};

const MODELS = ["Venue", "Order", "OrderItem", "OrderItemModifier"];

function lazy<T>(run: () => Promise<T>): Promise<T> {
  return {
    then: (resolve, reject) => run().then(resolve, reject),
  } as Promise<T>;
}

class FakeDatabase {
  readonly tables = new Map<string, UnknownRecord[]>();

  constructor() {
    for (const model of MODELS) this.tables.set(model, []);
  }

  rows(model: string): UnknownRecord[] {
    return this.tables.get(model)!;
  }

  private matches(model: string, row: UnknownRecord, where: unknown): boolean {
    if (where === undefined || where === null) return true;

    for (const [key, condition] of Object.entries(where as UnknownRecord)) {
      const relation = RELATIONS[model]?.[key];

      if (relation) {
        const parent = this.rows(relation.model).find(
          (candidate) => candidate.id === row[relation.foreignKey],
        );
        if (!parent || !this.matches(relation.model, parent, condition)) {
          return false;
        }
        continue;
      }

      const expected =
        typeof condition === "object" && condition !== null
          ? (condition as UnknownRecord).equals
          : condition;

      if (row[key] !== expected) return false;
    }

    return true;
  }

  private select(model: string, where: unknown): UnknownRecord[] {
    return this.rows(model).filter((row) => this.matches(model, row, where));
  }

  client(): Record<string, unknown> {
    const client: Record<string, unknown> = {};

    for (const model of MODELS) {
      const eager: Record<string, (args: UnknownRecord) => Promise<unknown>> = {
        findMany: async (args: UnknownRecord = {}) =>
          this.select(model, args.where),
        findFirst: async (args: UnknownRecord = {}) =>
          this.select(model, args.where)[0] ?? null,
        findFirstOrThrow: async (args: UnknownRecord = {}) => {
          const found = this.select(model, args.where)[0];
          if (!found) throw new Error("not found");
          return found;
        },
        findUnique: async (args: UnknownRecord) =>
          this.select(model, args.where)[0] ?? null,
        count: async (args: UnknownRecord = {}) =>
          this.select(model, args.where).length,
        create: async (args: UnknownRecord) => {
          const row = {
            id: `${model}-${this.rows(model).length + 1}`,
            ...(args.data as UnknownRecord),
          };
          this.rows(model).push(row);
          return row;
        },
        update: async (args: UnknownRecord) => {
          const found = this.select(model, args.where)[0];
          if (!found) throw new Error("record to update not found");
          Object.assign(found, args.data as UnknownRecord);
          return found;
        },
        updateMany: async (args: UnknownRecord) => {
          const found = this.select(model, args.where);
          for (const row of found)
            Object.assign(row, args.data as UnknownRecord);
          return { count: found.length };
        },
        delete: async (args: UnknownRecord) => {
          const found = this.select(model, args.where)[0];
          if (!found) throw new Error("record to delete not found");
          const table = this.rows(model);
          table.splice(table.indexOf(found), 1);
          return found;
        },
        deleteMany: async (args: UnknownRecord) => {
          const found = this.select(model, args.where);
          const table = this.rows(model);
          for (const row of found) table.splice(table.indexOf(row), 1);
          return { count: found.length };
        },
      };

      client[delegateKey(model)] = Object.fromEntries(
        Object.entries(eager).map(([operation, run]) => [
          operation,
          (args: UnknownRecord = {}) => lazy(async () => await run(args)),
        ]),
      );
    }

    return client;
  }
}

function makeTenancy() {
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
  });
}

function scopedClient(
  tenancy: ReturnType<typeof makeTenancy>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const forward = tenancy.extension(base).query.$allModels.$allOperations;
  const scoped: Record<string, unknown> = {};

  for (const model of MODELS) {
    const key = delegateKey(model);
    const delegate = base[key] as Record<
      string,
      (args: UnknownRecord) => Promise<unknown>
    >;
    const wrapped: Record<string, unknown> = {};

    for (const operation of Object.keys(delegate)) {
      wrapped[operation] = (args: UnknownRecord = {}) =>
        lazy(
          async () =>
            await forward({
              model,
              operation,
              args,
              query: async (passed: UnknownRecord) =>
                await delegate[operation]!(passed),
            }),
        );
    }

    scoped[key] = wrapped;
  }

  return scoped;
}

function seed(database: FakeDatabase, suffix: string): Record<string, string> {
  const organizationId = `org-${suffix}`;
  const venue = {
    id: `venue-${suffix}`,
    organizationId,
    name: `Venue ${suffix}`,
  };
  const order = { id: `order-${suffix}`, venueId: venue.id, total: 100 };
  const item = { id: `item-${suffix}`, orderId: order.id, quantity: 1 };
  const modifier = {
    id: `mod-${suffix}`,
    orderItemId: item.id,
    label: "extra",
  };

  database.rows("Venue").push(venue);
  database.rows("Order").push(order);
  database.rows("OrderItem").push(item);
  database.rows("OrderItemModifier").push(modifier);

  return {
    Venue: venue.id,
    Order: order.id,
    OrderItem: item.id,
    OrderItemModifier: modifier.id,
  };
}

describe("checkIsolation", () => {
  let database: FakeDatabase;
  let tenancy: ReturnType<typeof makeTenancy>;
  let base: Record<string, unknown>;
  let alpha: { scopes: Record<string, string>; rows: Record<string, string> };
  let beta: { scopes: Record<string, string>; rows: Record<string, string> };

  beforeEach(() => {
    database = new FakeDatabase();
    tenancy = makeTenancy();
    base = database.client();

    alpha = {
      scopes: { organization: "org-a", venue: "venue-a" },
      rows: seed(database, "a"),
    };
    beta = {
      scopes: { organization: "org-b", venue: "venue-b" },
      rows: seed(database, "b"),
    };
  });

  it("reports nothing against a guarded client", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: scopedClient(tenancy, base),
      alpha,
      beta,
    });

    expect(failures).toEqual([]);
  });

  it("covers every tenant-scoped and child model", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: base,
      alpha,
      beta,
    });

    expect(new Set(failures.map((failure) => failure.model))).toEqual(
      new Set(MODELS),
    );
  });

  it("catches a client that never filters", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: base,
      alpha,
      beta,
    });

    const orderChecks = failures
      .filter((failure) => failure.model === "Order")
      .map((failure) => failure.check);

    expect(orderChecks).toEqual(
      expect.arrayContaining([
        "findMany",
        "count",
        "findFirst",
        "findUnique",
        "update",
        "updateMany",
        "delete",
        "empty context",
        "no context",
      ]),
    );
  });

  it("reports that an unguarded delete consumed the other tenant's row", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: base,
      alpha,
      beta,
      models: ["Order"],
    });

    expect(failures).toContainEqual({
      model: "Order",
      check: "survival",
      detail: "the other tenant's row did not survive the write attempts",
    });
    expect(database.rows("Order")).toHaveLength(1);
  });

  it("says which model and check failed", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: base,
      alpha,
      beta,
      models: ["Order"],
    });

    expect(formatIsolationFailures(failures)).toContain(
      "- Order [findMany] the other tenant's row was listed",
    );
  });

  it("reports a model with no seeded fixture instead of skipping it", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: scopedClient(tenancy, base),
      alpha: { ...alpha, rows: {} },
      beta,
      models: ["Order"],
    });

    expect(failures).toEqual([
      {
        model: "Order",
        check: "fixtures",
        detail: "both tenants need a seeded row for this model",
      },
    ]);
  });

  it("checks that a create is stamped with the tenant from context", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: scopedClient(tenancy, base),
      alpha,
      beta,
      models: [],
      factories: { Order: () => ({ total: 500 }) },
    });

    expect(failures).toEqual([]);
  });

  it("catches a client that does not stamp on create", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: base,
      alpha,
      beta,
      models: [],
      factories: { Order: () => ({ total: 500 }) },
    });

    expect(failures).toEqual([
      {
        model: "Order",
        check: "stamping",
        detail: "create stored venueId=undefined instead of venue-a",
      },
      {
        model: "Order",
        check: "stamping",
        detail: "a create naming another tenant was accepted",
      },
    ]);
  });

  it("leaves no row behind after checking stamping", async () => {
    const before = database.rows("Order").length;

    await checkIsolation({
      tenancy,
      base,
      scoped: scopedClient(tenancy, base),
      alpha,
      beta,
      models: [],
      factories: { Order: () => ({ total: 500 }) },
    });

    expect(database.rows("Order")).toHaveLength(before);
  });

  it("rejects a factory for a model that is not tenant-scoped", async () => {
    const failures = await checkIsolation({
      tenancy,
      base,
      scoped: scopedClient(tenancy, base),
      alpha,
      beta,
      models: [],
      factories: { OrderItem: () => ({ quantity: 1 }) },
    });

    expect(failures).toEqual([
      {
        model: "OrderItem",
        check: "stamping",
        detail: "a factory was given for a model that is not tenant-scoped",
      },
    ]);
  });
});
