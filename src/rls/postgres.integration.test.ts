import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defineTenancy } from "../tenancy.js";
import { generateRls } from "./policies.js";
import { setConfigSql } from "./settings.js";

const connectionString = process.env["TENANT_GUARD_TEST_DATABASE_URL"];

const tenancy = defineTenancy({
  scopes: { organization: { column: "organization_id" } },
  models: { orders: "organization" },
  children: { order_lines: { path: ["order"], through: "orders" } },
});

const plan = generateRls(tenancy, {
  children: { order_lines: { foreignKey: "order_id" } },
});

describe.skipIf(!connectionString)("generated policies on postgres", () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    owner = new Client({ connectionString });
    await owner.connect();

    await owner.query(`
      DROP TABLE IF EXISTS order_lines, orders CASCADE;

      CREATE TABLE orders (
        id text PRIMARY KEY,
        organization_id text NOT NULL
      );
      CREATE TABLE order_lines (
        id text PRIMARY KEY,
        order_id text NOT NULL REFERENCES orders(id)
      );
      INSERT INTO orders VALUES ('o1', 'org-1'), ('o2', 'org-2');
      INSERT INTO order_lines VALUES ('l1', 'o1'), ('l2', 'o2');
    `);

    await owner.query(plan.sql);

    await owner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_guard_app') THEN
          CREATE ROLE tenant_guard_app LOGIN PASSWORD 'tenant_guard_app';
        END IF;
      END $$;
      GRANT ALL ON orders, order_lines TO tenant_guard_app;
    `);

    const url = new URL(connectionString as string);
    url.username = "tenant_guard_app";
    url.password = "tenant_guard_app";

    app = new Client({ connectionString: url.toString() });
    await app.connect();
  }, 60000);

  afterAll(async () => {
    await app?.end();
    await owner?.query("DROP TABLE IF EXISTS order_lines, orders CASCADE");
    await owner?.end();
  });

  it("shows a tenant only its own rows", async () => {
    await app.query("BEGIN");
    await app.query(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    );

    const { rows } = await app.query("SELECT id FROM orders ORDER BY id");
    await app.query("COMMIT");

    expect(rows.map((row) => row.id)).toEqual(["o1"]);
  });

  it("shows no rows at all when no tenant is set", async () => {
    const { rows } = await app.query("SELECT id FROM orders");

    expect(rows).toHaveLength(0);
  });

  it("refuses a write that would land in another tenant", async () => {
    await app.query("BEGIN");
    await app.query(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    );

    await expect(
      app.query("INSERT INTO orders VALUES ('o3', 'org-2')"),
    ).rejects.toThrow(/row-level security/i);

    await app.query("ROLLBACK");
  });

  it("refuses to move a row into another tenant", async () => {
    await app.query("BEGIN");
    await app.query(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    );

    await expect(
      app.query("UPDATE orders SET organization_id = 'org-2' WHERE id = 'o1'"),
    ).rejects.toThrow(/row-level security/i);

    await app.query("ROLLBACK");
  });

  it("reaches a child's tenant through its parent", async () => {
    await app.query("BEGIN");
    await app.query(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    );

    const { rows } = await app.query("SELECT id FROM order_lines ORDER BY id");
    await app.query("COMMIT");

    expect(rows.map((row) => row.id)).toEqual(["l1"]);
  });

  it("forgets the tenant when the transaction ends", async () => {
    await app.query("BEGIN");
    await app.query(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    );
    await app.query("COMMIT");

    const { rows } = await app.query("SELECT id FROM orders");

    expect(rows).toHaveLength(0);
  });
});
