import { describe, expect, it } from "vitest";

import { defineTenancy } from "../tenancy.js";
import { generateRls } from "./policies.js";

const tenancy = defineTenancy({
  scopes: {
    organization: { column: "organizationId" },
    venue: { column: "venueId" },
  },
  models: {
    Order: "organization",
    Booking: "venue",
  },
  children: {
    OrderLine: { path: ["order"], through: "Order" },
  },
  global: ["Country"],
});

describe("generateRls", () => {
  it("covers every tenant-scoped model", () => {
    const plan = generateRls(tenancy);

    expect(plan.covered).toEqual(["Order", "Booking"]);
  });

  it("turns row level security on and forces it for the owner too", () => {
    const plan = generateRls(tenancy);

    expect(plan.sql).toContain(
      'ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;',
    );
    expect(plan.sql).toContain('ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;');
  });

  it("can leave the owner exempt when asked", () => {
    const plan = generateRls(tenancy, { force: false });

    expect(plan.sql).not.toContain("FORCE ROW LEVEL SECURITY");
  });

  it("writes a policy that reads the scope's own setting", () => {
    const plan = generateRls(tenancy);

    expect(plan.sql).toContain(
      `"organizationId"::text = nullif(current_setting('app.organization_id', true), '')`,
    );
    expect(plan.sql).toContain(
      `"venueId"::text = nullif(current_setting('app.venue_id', true), '')`,
    );
  });

  it("guards writes as well as reads", () => {
    const policy = generateRls(tenancy).policies[0];

    expect(policy?.statements.at(-1)).toContain("USING (");
    expect(policy?.statements.at(-1)).toContain("WITH CHECK (");
  });

  it("drops an old policy before creating it, so it can be re-run", () => {
    const plan = generateRls(tenancy);

    expect(plan.sql).toContain(
      'DROP POLICY IF EXISTS "tenant_isolation" ON "Order";',
    );
  });

  it("treats an unset setting as no rows rather than every row", () => {
    const plan = generateRls(tenancy);

    expect(plan.sql).toContain("nullif(current_setting(");
  });

  it("casts to the column type when told to, so the index still works", () => {
    const plan = generateRls(tenancy, { cast: "uuid" });

    expect(plan.sql).toContain(
      `"organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid`,
    );
  });

  it("compares without a cast when asked", () => {
    const plan = generateRls(tenancy, { cast: "none" });

    expect(plan.sql).toContain(`"organizationId" = nullif(`);
  });

  it("follows a snake case schema", () => {
    const plan = generateRls(tenancy, { naming: "snake_case" });

    expect(plan.sql).toContain('ALTER TABLE "order" ENABLE ROW LEVEL SECURITY');
    expect(plan.sql).toContain('"organization_id"::text');
  });

  it("takes an explicit table or column name over the convention", () => {
    const plan = generateRls(tenancy, {
      tables: { Order: "orders" },
      columns: { organization: "org_id" },
    });

    expect(plan.sql).toContain('ALTER TABLE "orders"');
    expect(plan.sql).toContain('"org_id"::text');
  });

  it("renames the setting when the app namespaces it differently", () => {
    const plan = generateRls(tenancy, {
      settingName: (scope) => `tenant.${scope}`,
    });

    expect(plan.sql).toContain("current_setting('tenant.organization', true)");
  });

  it("leaves global models alone", () => {
    const plan = generateRls(tenancy);

    expect(plan.sql).not.toContain("Country");
  });

  it("reports a child it cannot reach instead of pretending it is covered", () => {
    const plan = generateRls(tenancy);

    expect(plan.uncovered).toEqual(["OrderLine"]);
    expect(plan.gaps[0]?.reason).toContain("foreign key");
  });

  it("covers a child once the join is declared", () => {
    const plan = generateRls(tenancy, {
      tables: { Order: "orders", OrderLine: "order_lines" },
      children: { OrderLine: { foreignKey: "order_id" } },
    });

    expect(plan.uncovered).toEqual([]);
    expect(plan.sql).toContain('ALTER TABLE "order_lines"');
    expect(plan.sql).toContain('SELECT 1 FROM "orders" AS parent');
    expect(plan.sql).toContain('WHERE parent."id" = "order_lines"."order_id"');
    expect(plan.sql).toContain(
      `AND parent."organizationId"::text = nullif(current_setting('app.organization_id', true), '')`,
    );
  });

  it("takes a parent key other than id", () => {
    const plan = generateRls(tenancy, {
      children: {
        OrderLine: {
          foreignKey: "order_ref",
          parentTable: "orders",
          parentKey: "reference",
        },
      },
    });

    expect(plan.sql).toContain('WHERE parent."reference" = ');
  });

  it("quotes every identifier it is handed", () => {
    const plan = generateRls(tenancy, {
      tables: { Order: 'weird"name' },
    });

    expect(plan.sql).toContain('ALTER TABLE "weird""name"');
  });
});

describe("assertRlsCoverage", () => {
  it("says nothing when every model is covered", async () => {
    const { assertRlsCoverage } = await import("./policies.js");

    expect(() =>
      assertRlsCoverage(
        generateRls(tenancy, {
          children: { OrderLine: { foreignKey: "order_id" } },
        }),
      ),
    ).not.toThrow();
  });

  it("fails a build that would ship an unenforced model", async () => {
    const { assertRlsCoverage } = await import("./policies.js");

    expect(() => assertRlsCoverage(generateRls(tenancy))).toThrow(
      /cannot write a policy for 1 model/,
    );
  });
});
