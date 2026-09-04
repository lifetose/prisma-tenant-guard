import { beforeEach, describe, expect, it } from "vitest";

import {
  TenantContextMissingError,
  TenantMismatchError,
  UnknownTenantModelError,
} from "./errors.js";
import { defineTenancy } from "./tenancy.js";
import type { UnknownRecord } from "./types.js";

interface Call {
  model: string;
  operation: string;
  args: UnknownRecord;
}

function makeTenancy(overrides: Record<string, unknown> = {}) {
  return defineTenancy({
    scopes: {
      organization: { column: "organizationId" },
      venue: { column: "venueId" },
    },
    models: { Venue: "organization", Order: "venue", Item: "venue" },
    children: {
      OrderItem: { path: ["order"], through: "Order" },
      OrderItemModifier: { path: ["orderItem", "order"], through: "Order" },
    },
    global: ["User"],
    ...overrides,
  });
}

const ALPHA = { organization: "org-1", venue: "venue-1" };

describe("the tenant guard", () => {
  let baseCalls: Call[];
  let base: Record<string, Record<string, unknown>>;
  let tenancy: ReturnType<typeof makeTenancy>;
  let run: (
    model: string,
    operation: string,
    args?: UnknownRecord,
  ) => Promise<UnknownRecord>;

  beforeEach(() => {
    baseCalls = [];
    base = {};

    for (const model of [
      "venue",
      "order",
      "item",
      "orderItem",
      "orderItemModifier",
    ]) {
      base[model] = {};
      for (const operation of ["findFirst", "findFirstOrThrow"]) {
        base[model]![operation] = async (args: UnknownRecord) => {
          baseCalls.push({ model, operation, args });
          return args;
        };
      }
    }

    tenancy = makeTenancy();

    const guard = tenancy.extension(base);
    const forward = guard.query.$allModels.$allOperations;

    run = async (model, operation, args = {}) =>
      (await forward({
        model,
        operation,
        args,
        query: async (passed: UnknownRecord) => passed,
      })) as UnknownRecord;
  });

  describe("reads", () => {
    it("filters findMany by the scope column", async () => {
      const args = await tenancy.run(ALPHA, () => run("Order", "findMany"));

      expect(args.where).toEqual({ venueId: "venue-1" });
    });

    it("reads the column of the scope the model belongs to", async () => {
      const args = await tenancy.run(ALPHA, () => run("Venue", "findMany"));

      expect(args.where).toEqual({ organizationId: "org-1" });
    });

    it("keeps the caller's own conditions alongside the tenant filter", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("Order", "findMany", { where: { status: "PAID" } }),
      );

      expect(args.where).toEqual({ status: "PAID", venueId: "venue-1" });
    });

    it("filters count, aggregate and groupBy", async () => {
      for (const operation of ["count", "aggregate", "groupBy"]) {
        const args = await tenancy.run(ALPHA, () => run("Order", operation));

        expect(args.where).toEqual({ venueId: "venue-1" });
      }
    });

    it("rewrites findUnique to findFirst on the base client", async () => {
      await tenancy.run(ALPHA, () =>
        run("Order", "findUnique", { where: { id: "o-1" } }),
      );

      expect(baseCalls).toEqual([
        {
          model: "order",
          operation: "findFirst",
          args: { where: { id: "o-1", venueId: "venue-1" } },
        },
      ]);
    });

    it("rewrites findUniqueOrThrow to findFirstOrThrow", async () => {
      await tenancy.run(ALPHA, () =>
        run("Order", "findUniqueOrThrow", { where: { id: "o-1" } }),
      );

      expect(baseCalls[0]?.operation).toBe("findFirstOrThrow");
    });
  });

  describe("writes", () => {
    it("stamps the tenant id onto create", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("Order", "create", { data: { total: 10 } }),
      );

      expect(args.data).toEqual({ total: 10, venueId: "venue-1" });
    });

    it("stamps every row of a createMany", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("Order", "createMany", { data: [{ total: 10 }, { total: 20 }] }),
      );

      expect(args.data).toEqual([
        { total: 10, venueId: "venue-1" },
        { total: 20, venueId: "venue-1" },
      ]);
    });

    it("filters update and delete by the scope column", async () => {
      for (const operation of [
        "update",
        "delete",
        "updateMany",
        "deleteMany",
      ]) {
        const args = await tenancy.run(ALPHA, () =>
          run("Order", operation, { where: { id: "o-1" }, data: {} }),
        );

        expect(args.where).toEqual({ id: "o-1", venueId: "venue-1" });
      }
    });

    it("filters the where of an upsert and stamps its create", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("Order", "upsert", {
          where: { id: "o-1" },
          create: { total: 10 },
          update: { total: 20 },
        }),
      );

      expect(args.where).toEqual({ id: "o-1", venueId: "venue-1" });
      expect(args.create).toEqual({ total: 10, venueId: "venue-1" });
    });
  });

  describe("attempts to leave the tenant", () => {
    it("refuses a create that names another tenant", async () => {
      await expect(
        tenancy.run(ALPHA, () =>
          run("Order", "create", { data: { venueId: "venue-2" } }),
        ),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it("overwrites instead of throwing when asked to", async () => {
      const lenient = makeTenancy({ onForeignTenantWrite: "overwrite" });
      const forward = lenient.extension(base).query.$allModels.$allOperations;

      const args = (await lenient.run(ALPHA, () =>
        forward({
          model: "Order",
          operation: "create",
          args: { data: { venueId: "venue-2" } },
          query: async (passed: UnknownRecord) => passed,
        }),
      )) as UnknownRecord;

      expect(args.data).toEqual({ venueId: "venue-1" });
    });

    it("refuses an update that moves a row to another tenant", async () => {
      await expect(
        tenancy.run(ALPHA, () =>
          run("Order", "update", {
            where: { id: "o-1" },
            data: { venueId: "venue-2" },
          }),
        ),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it("refuses an update written through a set wrapper", async () => {
      await expect(
        tenancy.run(ALPHA, () =>
          run("Order", "update", {
            where: { id: "o-1" },
            data: { venueId: { set: "venue-2" } },
          }),
        ),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it("refuses a read that names another tenant instead of silently rescoping it", async () => {
      await expect(
        tenancy.run(ALPHA, () =>
          run("Order", "findMany", { where: { venueId: "venue-2" } }),
        ),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it("accepts a read that names its own tenant", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("Order", "findMany", { where: { venueId: "venue-1" } }),
      );

      expect(args.where).toEqual({ venueId: "venue-1" });
    });

    it("refuses an update whose data touches the column of another tenant on upsert", async () => {
      await expect(
        tenancy.run(ALPHA, () =>
          run("Order", "upsert", {
            where: { id: "o-1" },
            create: {},
            update: { venueId: "venue-2" },
          }),
        ),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });
  });

  describe("child models", () => {
    it("filters through one relation", async () => {
      const args = await tenancy.run(ALPHA, () => run("OrderItem", "findMany"));

      expect(args.where).toEqual({ order: { venueId: "venue-1" } });
    });

    it("filters through a two-step path", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("OrderItemModifier", "findMany"),
      );

      expect(args.where).toEqual({
        orderItem: { order: { venueId: "venue-1" } },
      });
    });

    it("rewrites findUnique on a child to findFirst", async () => {
      await tenancy.run(ALPHA, () =>
        run("OrderItem", "findUnique", { where: { id: "oi-1" } }),
      );

      expect(baseCalls[0]).toEqual({
        model: "orderItem",
        operation: "findFirst",
        args: { where: { id: "oi-1", order: { venueId: "venue-1" } } },
      });
    });

    it("does not stamp a column the child does not have", async () => {
      const args = await tenancy.run(ALPHA, () =>
        run("OrderItem", "create", { data: { quantity: 2 } }),
      );

      expect(args.data).toEqual({ quantity: 2 });
    });
  });

  describe("models outside the tenant scopes", () => {
    it("lets a global model through untouched", async () => {
      const args = await tenancy.run({}, () =>
        run("User", "findMany", { where: { email: "a@b.c" } }),
      );

      expect(args.where).toEqual({ email: "a@b.c" });
    });

    it("refuses a model nobody classified", async () => {
      await expect(
        tenancy.run(ALPHA, () => run("Ghost", "findMany")),
      ).rejects.toBeInstanceOf(UnknownTenantModelError);
    });

    it("lets an unclassified model through when told to", async () => {
      const lenient = makeTenancy({ onUnknownModel: "allow" });
      const forward = lenient.extension(base).query.$allModels.$allOperations;

      await expect(
        lenient.run(ALPHA, () =>
          forward({
            model: "Ghost",
            operation: "findMany",
            args: {},
            query: async (passed: UnknownRecord) => passed,
          }),
        ),
      ).resolves.toEqual({});
    });

    it("lets a raw query with no model through", async () => {
      const forward = tenancy.extension(base).query.$allModels.$allOperations;

      await expect(
        forward({
          operation: "$queryRaw",
          args: { sql: "select 1" },
          query: async (passed: UnknownRecord) => passed,
        }),
      ).resolves.toEqual({ sql: "select 1" });
    });
  });

  describe("a missing tenant context", () => {
    it("throws when the context is empty", async () => {
      await expect(
        tenancy.run({}, () => run("Order", "findMany")),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it("throws when there is no context at all", async () => {
      await expect(run("Order", "findMany")).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });

    it("throws when the context holds a different scope than the model needs", async () => {
      await expect(
        tenancy.run({ organization: "org-1" }, () => run("Order", "findMany")),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it("names the model, the operation and the column it wanted", async () => {
      const error = await tenancy
        .run({}, () => run("Order", "findMany"))
        .catch((thrown: TenantContextMissingError) => thrown);

      expect(error).toMatchObject({
        model: "Order",
        operation: "findMany",
        scope: "venue",
        column: "venueId",
        code: "TENANT_CONTEXT_MISSING",
      });
    });

    it("throws for a child whose ancestor scope is missing", async () => {
      await expect(
        tenancy.run({}, () => run("OrderItem", "findMany")),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });
  });
});

describe("a tenancy whose context carries session data", () => {
  it("filters on the scope and ignores the rest", async () => {
    const tenancy = makeTenancy().withContext<{ userId: string }>();
    const forward = tenancy.extension({}).query.$allModels.$allOperations;

    const args = (await tenancy.run(
      { venue: "venue-1", organization: "org-1", userId: "u1" },
      async () =>
        await forward({
          model: "Order",
          operation: "findMany",
          args: {},
          query: async (passed: UnknownRecord) => passed,
        }),
    )) as UnknownRecord;

    expect(args.where).toEqual({ venueId: "venue-1" });
    expect(tenancy.current()).toBeUndefined();
  });
});
