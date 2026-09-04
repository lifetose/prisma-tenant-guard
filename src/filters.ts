import { TenantMismatchError } from "./errors.js";
import type { ForeignWritePolicy, UnknownRecord } from "./types.js";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addressedValue(condition: unknown): unknown {
  if (!isRecord(condition)) return condition;
  if ("equals" in condition) return condition.equals;
  if ("set" in condition) return condition.set;
  return condition;
}

export function mergeTenantWhere(
  model: string,
  where: unknown,
  column: string,
  tenantId: string,
): UnknownRecord {
  const base = isRecord(where) ? where : {};
  const existing = base[column];

  if (existing !== undefined && addressedValue(existing) !== tenantId) {
    throw new TenantMismatchError(model, column, tenantId, existing);
  }

  return { ...base, [column]: tenantId };
}

export function mergeChildWhere(
  where: unknown,
  filter: UnknownRecord,
): UnknownRecord {
  return { ...(isRecord(where) ? where : {}), ...filter };
}

function stampRecord(
  model: string,
  record: unknown,
  column: string,
  tenantId: string,
  policy: ForeignWritePolicy,
): unknown {
  if (!isRecord(record)) return record;

  const existing = record[column];
  if (
    existing !== undefined &&
    addressedValue(existing) !== tenantId &&
    policy === "throw"
  ) {
    throw new TenantMismatchError(model, column, tenantId, existing);
  }

  return { ...record, [column]: tenantId };
}

export function stampTenantData(
  model: string,
  data: unknown,
  column: string,
  tenantId: string,
  policy: ForeignWritePolicy,
): unknown {
  if (Array.isArray(data)) {
    return data.map((entry) =>
      stampRecord(model, entry, column, tenantId, policy),
    );
  }

  return stampRecord(model, data, column, tenantId, policy);
}

export function assertDataKeepsTenant(
  model: string,
  data: unknown,
  column: string,
  tenantId: string,
): void {
  if (!isRecord(data)) return;

  const existing = data[column];
  if (existing === undefined) return;

  if (addressedValue(existing) !== tenantId) {
    throw new TenantMismatchError(model, column, tenantId, existing);
  }
}
