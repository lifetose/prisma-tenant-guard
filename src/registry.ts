import { TenancyConfigError } from "./errors.js";
import type {
  ChildPath,
  ForeignWritePolicy,
  ScopeDefinition,
  TenancyConfig,
  UnknownModelPolicy,
  UnknownRecord,
} from "./types.js";

export interface TenantModelEntry {
  model: string;
  scope: string;
  column: string;
}

export interface ChildModelEntry {
  model: string;
  path: readonly string[];
  through: string;
  scope: string;
  column: string;
}

export type Classification = "tenant" | "child" | "global";

export class TenancyRegistry {
  readonly scopes: ReadonlyMap<string, ScopeDefinition>;
  readonly tenantModels: ReadonlyMap<string, TenantModelEntry>;
  readonly childModels: ReadonlyMap<string, ChildModelEntry>;
  readonly globalModels: ReadonlySet<string>;
  readonly onForeignTenantWrite: ForeignWritePolicy;
  readonly onUnknownModel: UnknownModelPolicy;

  constructor(config: TenancyConfig) {
    const scopes = new Map(Object.entries(config.scopes));
    if (scopes.size === 0) {
      throw new TenancyConfigError("a tenancy needs at least one scope");
    }

    for (const [name, definition] of scopes) {
      if (!definition?.column) {
        throw new TenancyConfigError(`scope "${name}" has no column`);
      }
    }

    const tenantModels = new Map<string, TenantModelEntry>();
    for (const [model, scope] of Object.entries(config.models)) {
      const definition = scopes.get(scope);
      if (!definition) {
        throw new TenancyConfigError(
          `model "${model}" is scoped to "${scope}", which is not a declared scope`,
        );
      }
      tenantModels.set(model, { model, scope, column: definition.column });
    }

    const childModels = new Map<string, ChildModelEntry>();
    for (const [model, child] of Object.entries<ChildPath>(
      config.children ?? {},
    )) {
      if (tenantModels.has(model)) {
        throw new TenancyConfigError(
          `model "${model}" is classified both as tenant-scoped and as a child`,
        );
      }
      if (child.path.length === 0) {
        throw new TenancyConfigError(`child "${model}" has an empty path`);
      }

      const parent = tenantModels.get(child.through);
      if (!parent) {
        throw new TenancyConfigError(
          `child "${model}" routes through "${child.through}", which is not a tenant-scoped model`,
        );
      }

      childModels.set(model, {
        model,
        path: child.path,
        through: child.through,
        scope: parent.scope,
        column: parent.column,
      });
    }

    const globalModels = new Set(config.global ?? []);
    for (const model of globalModels) {
      if (tenantModels.has(model) || childModels.has(model)) {
        throw new TenancyConfigError(
          `model "${model}" is classified both as global and as tenant-scoped`,
        );
      }
    }

    this.scopes = scopes;
    this.tenantModels = tenantModels;
    this.childModels = childModels;
    this.globalModels = globalModels;
    this.onForeignTenantWrite = config.onForeignTenantWrite ?? "throw";
    this.onUnknownModel = config.onUnknownModel ?? "throw";
  }

  get scopeNames(): string[] {
    return [...this.scopes.keys()];
  }

  columnOf(scope: string): string | undefined {
    return this.scopes.get(scope)?.column;
  }

  tenantEntry(model: string | undefined): TenantModelEntry | undefined {
    return model === undefined ? undefined : this.tenantModels.get(model);
  }

  childEntry(model: string | undefined): ChildModelEntry | undefined {
    return model === undefined ? undefined : this.childModels.get(model);
  }

  classify(model: string): Classification | undefined {
    if (this.tenantModels.has(model)) return "tenant";
    if (this.childModels.has(model)) return "child";
    if (this.globalModels.has(model)) return "global";
    return undefined;
  }

  classified(): string[] {
    return [
      ...this.tenantModels.keys(),
      ...this.childModels.keys(),
      ...this.globalModels,
    ];
  }
}

export function nestThroughPath(
  path: readonly string[],
  leaf: UnknownRecord,
): UnknownRecord {
  return path.reduceRight<UnknownRecord>(
    (inner, relation) => ({ [relation]: inner }),
    leaf,
  );
}

export function childTenantFilter(
  child: Pick<ChildModelEntry, "path" | "column">,
  tenantId: string,
): UnknownRecord {
  return nestThroughPath(child.path, { [child.column]: tenantId });
}

export function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}
