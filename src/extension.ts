import { TenantStore } from "./context.js";
import {
  TenantContextMissingError,
  UnknownTenantModelError,
} from "./errors.js";
import {
  assertDataKeepsTenant,
  mergeChildWhere,
  mergeTenantWhere,
  stampTenantData,
} from "./filters.js";
import { childTenantFilter, delegateKey, TenancyRegistry } from "./registry.js";
import type { QueryExtensionArgs, UnknownRecord } from "./types.js";

const FILTERED_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

const CREATE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
]);

const UPDATE_OPERATIONS = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
]);

const UNIQUE_TO_FIRST: Record<string, string> = {
  findUnique: "findFirst",
  findUniqueOrThrow: "findFirstOrThrow",
};

type Delegates = Record<string, Record<string, unknown> | undefined>;

function runOnBase(
  base: unknown,
  model: string,
  operation: string,
  args: UnknownRecord,
): Promise<unknown> {
  const delegates = base as Delegates;
  const delegate = delegates[delegateKey(model)] ?? {};
  const run = delegate[operation] as (a: UnknownRecord) => Promise<unknown>;

  return run.call(delegate, args);
}

export function createTenantGuard(
  registry: TenancyRegistry,
  store: TenantStore,
  base: unknown,
) {
  const requireTenantId = (
    model: string,
    operation: string,
    scope: string,
    column: string,
  ): string => {
    const id = store.get(scope);
    if (id === undefined) {
      throw new TenantContextMissingError(model, operation, scope, column);
    }

    return id;
  };

  const scopedChildQuery = async ({
    model,
    operation,
    args,
    query,
  }: QueryExtensionArgs): Promise<unknown> => {
    const child = registry.childEntry(model)!;
    const name = model!;
    const id = requireTenantId(name, operation, child.scope, child.column);
    const filter = childTenantFilter(child, id);

    if (FILTERED_OPERATIONS.has(operation) || operation === "upsert") {
      return await query({
        ...args,
        where: mergeChildWhere(args.where, filter),
      });
    }

    const rewritten = UNIQUE_TO_FIRST[operation];
    if (rewritten) {
      return await runOnBase(base, name, rewritten, {
        ...args,
        where: mergeChildWhere(args.where, filter),
      });
    }

    return await query(args);
  };

  const scopedTenantQuery = async ({
    model,
    operation,
    args,
    query,
  }: QueryExtensionArgs): Promise<unknown> => {
    const entry = registry.tenantEntry(model)!;
    const name = model!;
    const { column } = entry;
    const id = requireTenantId(name, operation, entry.scope, column);

    if (CREATE_OPERATIONS.has(operation)) {
      return await query({
        ...args,
        data: stampTenantData(
          name,
          args.data,
          column,
          id,
          registry.onForeignTenantWrite,
        ),
      });
    }

    if (operation === "upsert") {
      assertDataKeepsTenant(name, args.update, column, id);

      return await query({
        ...args,
        where: mergeTenantWhere(name, args.where, column, id),
        create: stampTenantData(
          name,
          args.create,
          column,
          id,
          registry.onForeignTenantWrite,
        ),
      });
    }

    if (UPDATE_OPERATIONS.has(operation)) {
      assertDataKeepsTenant(name, args.data, column, id);
    }

    if (FILTERED_OPERATIONS.has(operation)) {
      return await query({
        ...args,
        where: mergeTenantWhere(name, args.where, column, id),
      });
    }

    const rewritten = UNIQUE_TO_FIRST[operation];
    if (rewritten) {
      return await runOnBase(base, name, rewritten, {
        ...args,
        where: mergeTenantWhere(name, args.where, column, id),
      });
    }

    return await query(args);
  };

  const scopedQuery = async (params: QueryExtensionArgs): Promise<unknown> => {
    const { model, args, query } = params;

    if (!model) return await query(args);
    if (registry.tenantEntry(model)) return await scopedTenantQuery(params);
    if (registry.childEntry(model)) return await scopedChildQuery(params);
    if (registry.globalModels.has(model)) return await query(args);

    if (registry.onUnknownModel === "throw") {
      throw new UnknownTenantModelError(model);
    }

    return await query(args);
  };

  return {
    name: "prisma-tenant-guard",
    client: {
      $unscoped(): unknown {
        return base;
      },
    },
    query: {
      $allModels: {
        $allOperations: scopedQuery,
      },
    },
  };
}
