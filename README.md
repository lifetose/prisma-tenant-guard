# prisma-tenant-guard

[![npm](https://img.shields.io/npm/v/prisma-tenant-guard.svg)](https://www.npmjs.com/package/prisma-tenant-guard)
[![ci](https://github.com/lifetose/prisma-tenant-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/lifetose/prisma-tenant-guard/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/prisma-tenant-guard.svg)](https://www.npmjs.com/package/prisma-tenant-guard)
[![license](https://img.shields.io/npm/l/prisma-tenant-guard.svg)](./LICENSE)

Row-level multi-tenancy for Prisma, in three parts:

- a **tenant context** on `AsyncLocalStorage`, so nothing has to thread a tenant id through call sites,
- a **client extension** that filters every read, stamps every write, and throws when a tenant-scoped
  model is touched with no context,
- a **test kit** that proves no model escaped — the part that is usually left as an exercise.

Extracted from a multi-tenant SaaS where it gates CI over 53 models. No dependencies, no
`@prisma/client` peer, no code generation: the extension is structural, so it works with whatever
Prisma version and client output path you already have. Ships CommonJS and ESM, so it drops into a
NestJS app as readily as an ESM one.

```bash
npm install prisma-tenant-guard
```

If you came here looking for `prisma-multi-tenant`: that one is a CLI for reaching **multiple
databases**, one per tenant, and its last release was 2.4.2 in November 2020 — before Prisma had
client extensions. This is the other shape: one database, one schema, a tenant column per row,
enforced through `$extends`.

## Declaring the tenancy

Scopes are yours to name. A scope is a column that says who a row belongs to; most apps have one,
and apps with an org/workspace split have two.

```ts
import { defineTenancy } from "prisma-tenant-guard";

export const tenancy = defineTenancy({
  scopes: {
    organization: { column: "organizationId" },
    venue: { column: "venueId" },
  },
  models: {
    Venue: "organization",
    Membership: "organization",
    Order: "venue",
    Item: "venue",
  },
  children: {
    OrderItem: { path: ["order"], through: "Order" },
    OrderItemModifier: { path: ["orderItem", "order"], through: "Order" },
  },
  global: ["User", "Session", "Plan"],
});
```

- **`models`** — tables that carry a scope column themselves. Filtered and stamped directly.
- **`children`** — tables that carry no scope column and reach one through a relation. `path` is the
  chain of `to-one` relations from the child up to `through`, so `OrderItem` is filtered as
  `{ order: { venueId } }` and `OrderItemModifier` as `{ orderItem: { order: { venueId } } }`.
- **`global`** — tables that belong to nobody. Listed explicitly, because _silence is the bug this
  package exists to prevent_: a model that is in none of the three lists throws at query time rather
  than quietly returning every tenant's rows. Set `onUnknownModel: "allow"` while migrating.

## Wiring the client

```ts
import { PrismaClient } from "@prisma/client";
import { tenancy } from "./tenancy.js";

export const prisma = tenancy.protect(new PrismaClient());
```

`protect` returns the extended client plus `$unscoped()`, which hands back the raw client for the
few places that legitimately cross tenants — provisioning, platform admin, migrations, cron.

Then run each request inside a context:

```ts
app.use((req, res, next) => {
  tenancy.run(
    { organization: req.auth.organizationId, venue: req.auth.venueId },
    next,
  );
});
```

### One trap: Prisma promises are lazy

A Prisma call does not run when you make it — it runs when it is awaited. So a context that ends
before the `await` is a context the query never sees:

```ts
const orders = await tenancy.run(scopes, () => prisma.order.findMany());
```

`findMany()` builds a promise inside the context, `run` returns it, and the query executes after the
context is gone — `TenantContextMissingError`. Await inside instead:

```ts
const orders = await tenancy.run(
  scopes,
  async () => await prisma.order.findMany(),
);
```

Request-scoped middleware has no such problem, because the whole handler runs inside `run`. This
only bites when a `run` returns a promise that is awaited outside it.

From there, application code says what it means:

```ts
await prisma.order.findMany({ where: { status: "PAID" } });
```

and the query that reaches Postgres is `WHERE status = 'PAID' AND "venueId" = $1`.

### With NestJS

`AsyncLocalStorage` survives Nest's request pipeline, so a guard is enough — but it must be a
**guard**, not an interceptor: Nest runs guards first, and an interceptor would leave your roles
guard reading an empty context.

```ts
@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(host: ExecutionContext): boolean {
    const request = host.switchToHttp().getRequest();
    tenancy.assign({ organization: request.user.organizationId });
    return true;
  }
}
```

Call `tenancy.run({}, next)` from middleware so a store exists, then `assign` into it from the guard
once the user is known.

## What the extension does

| Operation                                            | Behaviour                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `findMany` `findFirst` `count` `aggregate` `groupBy` | scope column merged into `where`                                                                                                         |
| `findUnique` `findUniqueOrThrow`                     | rewritten to `findFirst` / `findFirstOrThrow` with the scope merged, so a guessed id from another tenant returns `null` instead of a row |
| `update` `delete`                                    | scope merged into `where`; a foreign id matches nothing and Prisma raises `P2025`, which your error filter already renders as a 404      |
| `updateMany` `deleteMany`                            | scope merged into `where`; a foreign id yields `{ count: 0 }`                                                                            |
| `create` `createMany`                                | scope column stamped from context, overriding whatever was passed                                                                        |
| `upsert`                                             | `where` filtered, `create` stamped, `update` checked                                                                                     |

Two attempts to leave the tenant are refused rather than silently corrected:

- **A write that names another tenant** — `create({ data: { venueId: theirs } })`, or an update that
  moves a row across — throws `TenantMismatchError`. Set `onForeignTenantWrite: "overwrite"` for the
  older behaviour of quietly rewriting it.
- **A read that names another tenant** — `findMany({ where: { venueId: theirs } })` throws too. It
  cannot leak either way, but silently rescoping it would answer a question nobody asked; in an app
  with several venues per org that is a wrong result, not a blocked one.

## What it does not do

Read this list. Everything on it is a real hole, not a rough edge.

- **Raw SQL is not filtered.** `$queryRaw`, `$executeRaw` and `findRaw` carry no model, so they pass
  straight through. Add the scope yourself.
- **Nested writes are not intercepted.** `organization.create({ data: { venues: { create } } })`
  reaches the inner model without going through the extension. Do provisioning-shaped writes in an
  explicit `$unscoped()` transaction, or split them.
- **The extension alone is not a substitute for Postgres RLS.** It guards one application's Prisma
  client; anything else holding the same credentials — psql, a migration, another service — is
  unaffected. That is what `prisma-tenant-guard/rls` is for: the same config, enforced by the
  database as well.
- **Child paths must be `to-one`.** A path through a list relation is rejected by the audit.

## Enforcing it in the database too

The extension filters the client. Raw SQL is the hole it cannot close — and the list above says so.
`prisma-tenant-guard/rls` closes it from the other side, generating Postgres row level security
from the tenancy you already declared, so the rule lives in one place and is enforced in two.

```ts
import { generateRls, assertRlsCoverage } from "prisma-tenant-guard/rls";

const plan = generateRls(tenancy, {
  naming: "snake_case",
  cast: "uuid",
  children: { OrderLine: { foreignKey: "order_id" } },
});

assertRlsCoverage(plan);

writeFileSync("prisma/migrations/…/migration.sql", plan.sql);
```

For each tenant-scoped model it emits:

```sql
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "order";
CREATE POLICY "tenant_isolation" ON "order"
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);
```

Four decisions are load-bearing:

- **`FORCE`**, because plain `ENABLE` exempts the table's owner — and the owner is usually exactly
  the role your app connects as, which would make every policy decorative.
- **`nullif(…, '')`**, because `set_config` writes an empty string rather than NULL. Without it an
  unset tenant compares equal to an empty column instead of matching nothing, and the failure mode
  of a missing context becomes _too many rows_ rather than none.
- **`WITH CHECK` as well as `USING`**, so a write cannot place a row in another tenant.
- **`::text` by default**, which is correct for uuid, int and text columns alike. Pass
  `cast: "uuid"` once you know the type — it compares against the column directly, so the index is
  still used.

### Setting the tenant on the connection

The policies read a session setting, so the transaction has to carry one:

```ts
import { setConfigSql, tenantSettings } from "prisma-tenant-guard/rls";

await prisma.$transaction(async (tx) => {
  for (const setting of tenantSettings(tenancy)) {
    await tx.$executeRawUnsafe(setConfigSql(setting));
  }

  return tx.order.findMany();
});
```

`set_config(…, true)` is transaction-local, so it cannot leak to the next request that borrows the
same pooled connection.

### The models it will not silently skip

A child model has no tenant column — it reaches its tenant through a parent — so a policy for it
needs the foreign key, which the tenancy config does not carry. Rather than quietly leaving those
tables unprotected, `generateRls` reports them:

```ts
generateRls(tenancy).uncovered; // ["OrderLine"]
```

Declare the join to cover it, and `assertRlsCoverage` fails the build until every model is either
covered or deliberately global — the same refusal-to-guess as the test kit.

```ts
generateRls(tenancy, {
  children: { OrderLine: { foreignKey: "order_id" } },
});
```

### Before you trust it

Postgres skips RLS entirely for superusers and for roles with `BYPASSRLS`. Connect your application
as a plain role that owns nothing, and check it:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

Both must be `false`, or the policies above are theatre.

The generated SQL is not taken on trust either: CI applies it to a real Postgres, then connects as
an unprivileged role and checks that a tenant sees only its own rows, that an unset context sees
none, that a write into another tenant is refused, that a row cannot be moved between tenants, and
that a child is reached through its parent. Point `TENANT_GUARD_TEST_DATABASE_URL` at a database to
run the same checks locally:

```bash
TENANT_GUARD_TEST_DATABASE_URL=postgres://… npx vitest run src/rls/postgres.integration.test.ts
```

## The test kit

The extension is only as good as the registry, and a registry drifts: someone adds a model and
forgets to classify it. Both halves of the kit exist to make that impossible to do quietly.

### Static: does the registry match the schema?

No database needed. Fast enough to be a unit test.

```ts
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { assertTenancy } from "prisma-tenant-guard/testing";

import { tenancy } from "../src/tenancy.js";

it("classifies every model in the schema", () => {
  assertTenancy(tenancy, {
    schema: readFileSync("prisma/schema.prisma", "utf8"),
    models: Object.keys(Prisma.ModelName),
  });
});
```

That one assertion catches:

| Finding            | What went wrong                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `unclassified`     | a model exists and is in none of the three lists                                                                           |
| `stale`            | a classified model is no longer in the schema                                                                              |
| `missing-column`   | a model is scoped to `venue` but has no `venueId` column — the typo that produces a filter matching nothing, or everything |
| `unknown-relation` | a child's path names a relation the model does not have                                                                    |
| `list-relation`    | a child's path goes through a `to-many` relation                                                                           |
| `wrong-terminus`   | a child's path ends at a different model than the one it claims                                                            |

Use `auditTenancy` instead of `assertTenancy` to get the findings as data, and `formatFindings` to
render them.

### Dynamic: does the client actually isolate?

Seed two tenants, hand over one row id per model, and get back a list of everything that leaked.

```ts
import {
  checkIsolation,
  formatIsolationFailures,
} from "prisma-tenant-guard/testing";

it("keeps two tenants apart", async () => {
  const failures = await checkIsolation({
    tenancy,
    base,
    scoped,
    alpha: {
      scopes: { organization: "org-a", venue: "venue-a" },
      rows: alphaRows,
    },
    beta: {
      scopes: { organization: "org-b", venue: "venue-b" },
      rows: betaRows,
    },
    factories: { Order: () => ({ total: 500 }) },
  });

  expect(formatIsolationFailures(failures)).toBe("");
});
```

Per model it checks that the other tenant's row is not listed, not counted, not reachable by
`findFirst` or `findUnique`, not updatable, not deletable — and that a query with an empty context,
or with no context at all, throws `TenantContextMissingError`. Pass `factories` and it also checks
that `create` stamps the tenant from context and refuses a row addressed to someone else.

Two practical notes. `rows` is keyed by model name, so a new model with no fixture is reported
rather than skipped. And if the guard really is broken, the destructive checks will consume the beta
fixtures — re-seed between runs.

## API

|                                         |                                                       |
| --------------------------------------- | ----------------------------------------------------- |
| `defineTenancy(config)`                 | build a tenancy                                       |
| `tenancy.protect(client)`               | extend a Prisma client, adding `$unscoped()`          |
| `tenancy.extension(base)`               | the raw extension, if you compose `$extends` yourself |
| `tenancy.run(scopes, fn)`               | run `fn` inside a tenant context                      |
| `tenancy.assign(patch)`                 | add scopes to the running context                     |
| `tenancy.get(scope)` / `require(scope)` | read one scope                                        |
| `tenancy.unscoped(fn)`                  | run `fn` with no context at all                       |
| `tenancy.registry`                      | the resolved classification, for tooling              |

From `prisma-tenant-guard/rls`:

|                              |                                              |
| ---------------------------- | -------------------------------------------- |
| `generateRls(tenancy, opts)` | policies, plus the models it could not cover |
| `assertRlsCoverage(plan)`    | throw unless every model is covered          |
| `tenantSettings(tenancy)`    | the settings the current context implies     |
| `setConfigSql(setting)`      | transaction-local `set_config`, escaped      |

Errors carry a `code` (`TENANT_CONTEXT_MISSING`, `TENANT_MISMATCH`, `TENANT_MODEL_UNKNOWN`,
`TENANT_CONFIG_INVALID`) alongside the model, operation and column, so an exception filter can map
them without string matching.

## License

MIT
