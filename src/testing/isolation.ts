import { TenantContextMissingError } from "../errors.js";
import { delegateKey, type TenancyRegistry } from "../registry.js";
import type { TenantScopes, UnknownRecord } from "../types.js";

export interface DelegateLike {
  findMany: (args?: UnknownRecord) => Promise<UnknownRecord[]>;
  findFirst: (args?: UnknownRecord) => Promise<UnknownRecord | null>;
  findUnique: (args: UnknownRecord) => Promise<UnknownRecord | null>;
  count: (args?: UnknownRecord) => Promise<number>;
  update: (args: UnknownRecord) => Promise<UnknownRecord>;
  updateMany: (args: UnknownRecord) => Promise<{ count: number }>;
  delete: (args: UnknownRecord) => Promise<UnknownRecord>;
  deleteMany: (args: UnknownRecord) => Promise<{ count: number }>;
  create: (args: UnknownRecord) => Promise<UnknownRecord>;
}

export interface CheckableTenancy<TScope extends string = string> {
  readonly registry: TenancyRegistry;
  run<T>(context: TenantScopes<TScope>, callback: () => T): T;
  unscoped<T>(callback: () => T): T;
}

export interface IsolationTenant<TScope extends string = string> {
  scopes: TenantScopes<TScope>;
  rows: Record<string, string>;
}

export interface IsolationOptions<TScope extends string = string> {
  tenancy: CheckableTenancy<TScope>;
  base: unknown;
  scoped: unknown;
  alpha: IsolationTenant<TScope>;
  beta: IsolationTenant<TScope>;
  models?: readonly string[];
  idField?: string;
  factories?: Record<
    string,
    (tenant: IsolationTenant<TScope>) => UnknownRecord
  >;
}

export interface IsolationFailure {
  model: string;
  check: string;
  detail: string;
}

function delegateOf(client: unknown, model: string): DelegateLike {
  const delegates = client as Record<string, DelegateLike | undefined>;
  const delegate = delegates[delegateKey(model)];

  if (!delegate) throw new Error(`client has no delegate for ${model}`);

  return delegate;
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function throwsMissingContext(
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof TenantContextMissingError;
  }
}

export async function checkIsolation<TScope extends string = string>(
  options: IsolationOptions<TScope>,
): Promise<IsolationFailure[]> {
  const { tenancy, base, scoped, alpha, beta } = options;
  const idField = options.idField ?? "id";
  const registry = tenancy.registry;
  const models = options.models ?? [
    ...registry.tenantModels.keys(),
    ...registry.childModels.keys(),
  ];

  const failures: IsolationFailure[] = [];
  const fail = (model: string, check: string, detail: string): void => {
    failures.push({ model, check, detail });
  };

  for (const model of models) {
    const isTenantModel = registry.tenantModels.has(model);
    const alphaId = alpha.rows[model];
    const betaId = beta.rows[model];

    if (!alphaId || !betaId) {
      fail(model, "fixtures", "both tenants need a seeded row for this model");
      continue;
    }

    const scopedDelegate = delegateOf(scoped, model);
    const baseDelegate = delegateOf(base, model);

    const asAlpha = async <T>(run: () => Promise<T>): Promise<T> =>
      await tenancy.run(alpha.scopes, async () => await run());

    const listed = await asAlpha(() => scopedDelegate.findMany({}));
    const ids = listed.map((row) => row[idField]);

    if (!ids.includes(alphaId)) {
      fail(model, "findMany", "the tenant's own row was not listed");
    }
    if (ids.includes(betaId)) {
      fail(model, "findMany", "the other tenant's row was listed");
    }

    const mine = await asAlpha(() => scopedDelegate.count({}));
    const total = await baseDelegate.count({});

    if (mine >= total) {
      fail(
        model,
        "count",
        `scoped count ${mine} did not exclude other tenants (${total} rows)`,
      );
    }

    const foundForeign = await asAlpha(() =>
      scopedDelegate.findFirst({ where: { [idField]: betaId } }),
    );
    if (foundForeign !== null) {
      fail(model, "findFirst", "reached the other tenant's row by id");
    }

    const uniqueForeign = await asAlpha(() =>
      scopedDelegate.findUnique({ where: { [idField]: betaId } }),
    );
    if (uniqueForeign !== null) {
      fail(model, "findUnique", "reached the other tenant's row by id");
    }

    const uniqueOwn = await asAlpha(() =>
      scopedDelegate.findUnique({ where: { [idField]: alphaId } }),
    );
    if (uniqueOwn?.[idField] !== alphaId) {
      fail(model, "findUnique", "could not reach its own row by id");
    }

    if (isTenantModel) {
      const updateRejected = await asAlpha(() =>
        rejects(() =>
          scopedDelegate.update({ where: { [idField]: betaId }, data: {} }),
        ),
      );
      if (!updateRejected) {
        fail(model, "update", "updated the other tenant's row by id");
      }
    }

    const updatedMany = await asAlpha(() =>
      scopedDelegate.updateMany({ where: { [idField]: betaId }, data: {} }),
    );
    if (updatedMany.count !== 0) {
      fail(
        model,
        "updateMany",
        `updated ${updatedMany.count} row(s) of the other tenant`,
      );
    }

    const deleteRejected = await asAlpha(() =>
      rejects(() => scopedDelegate.delete({ where: { [idField]: betaId } })),
    );
    if (!deleteRejected) {
      fail(model, "delete", "deleted the other tenant's row by id");
    }

    const deletedMany = await asAlpha(() =>
      scopedDelegate.deleteMany({ where: { [idField]: betaId } }),
    );
    if (deletedMany.count !== 0) {
      fail(
        model,
        "deleteMany",
        `deleted ${deletedMany.count} row(s) of the other tenant`,
      );
    }

    const survived = await baseDelegate.findFirst({
      where: { [idField]: betaId },
    });
    if (survived === null) {
      fail(
        model,
        "survival",
        "the other tenant's row did not survive the write attempts",
      );
    }

    const emptyThrew = await tenancy.run(
      {},
      async () =>
        await throwsMissingContext(
          async () => await scopedDelegate.findMany({}),
        ),
    );
    if (!emptyThrew) {
      fail(
        model,
        "empty context",
        "queried with an empty tenant context instead of throwing",
      );
    }

    const noneThrew = await tenancy.unscoped(
      async () =>
        await throwsMissingContext(
          async () => await scopedDelegate.findMany({}),
        ),
    );
    if (!noneThrew) {
      fail(
        model,
        "no context",
        "queried with no tenant context instead of throwing",
      );
    }
  }

  failures.push(...(await checkStamping(options, idField)));

  return failures;
}

async function checkStamping<TScope extends string>(
  options: IsolationOptions<TScope>,
  idField: string,
): Promise<IsolationFailure[]> {
  const { tenancy, base, scoped, alpha, beta, factories } = options;
  if (!factories) return [];

  const failures: IsolationFailure[] = [];
  const registry = tenancy.registry;

  for (const [model, factory] of Object.entries(factories)) {
    const entry = registry.tenantEntry(model);
    if (!entry) {
      failures.push({
        model,
        check: "stamping",
        detail: "a factory was given for a model that is not tenant-scoped",
      });
      continue;
    }

    const expected = alpha.scopes[entry.scope as TScope];
    const scopedDelegate = delegateOf(scoped, model);
    const baseDelegate = delegateOf(base, model);

    const created = await tenancy.run(
      alpha.scopes,
      async () => await scopedDelegate.create({ data: factory(alpha) }),
    );

    const stored = await baseDelegate.findFirst({
      where: { [idField]: created[idField] },
    });

    if (stored?.[entry.column] !== expected) {
      failures.push({
        model,
        check: "stamping",
        detail: `create stored ${entry.column}=${String(stored?.[entry.column])} instead of ${String(expected)}`,
      });
    }

    const foreign = beta.scopes[entry.scope as TScope];
    const refused = await tenancy.run(
      alpha.scopes,
      async () =>
        await rejects(
          async () =>
            await scopedDelegate.create({
              data: { ...factory(alpha), [entry.column]: foreign },
            }),
        ),
    );

    if (registry.onForeignTenantWrite === "throw" && !refused) {
      failures.push({
        model,
        check: "stamping",
        detail: "a create naming another tenant was accepted",
      });
    }

    await baseDelegate.deleteMany({ where: { [idField]: created[idField] } });
  }

  return failures;
}

export function formatIsolationFailures(
  failures: readonly IsolationFailure[],
): string {
  return failures
    .map((failure) => `- ${failure.model} [${failure.check}] ${failure.detail}`)
    .join("\n");
}
