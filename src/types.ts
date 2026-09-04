export interface ScopeDefinition {
  column: string;
}

export interface ChildPath<TModel extends string = string> {
  path: readonly string[];
  through: TModel;
}

export type ForeignWritePolicy = "throw" | "overwrite";

export type UnknownModelPolicy = "throw" | "allow";

export interface TenancyConfig<
  TScope extends string = string,
  TModel extends string = string,
  TChild extends string = string,
> {
  scopes: Record<TScope, ScopeDefinition>;
  models: Record<TModel, TScope>;
  children?: Record<TChild, ChildPath<NoInfer<TModel>>>;
  global?: readonly string[];
  onForeignTenantWrite?: ForeignWritePolicy;
  onUnknownModel?: UnknownModelPolicy;
}

export type TenantScopes<TScope extends string = string> = Partial<
  Record<TScope, string>
>;

export type TenantContext<
  TScope extends string = string,
  TExtra extends object = EmptyContext,
> = TenantScopes<TScope> & Partial<TExtra>;

export type EmptyContext = Record<never, never>;

export type UnknownRecord = Record<string, unknown>;

export interface QueryExtensionArgs {
  model?: string;
  operation: string;
  args: UnknownRecord;
  query: (args: UnknownRecord) => Promise<unknown>;
}

export interface PrismaLike {
  $extends: (extension: never) => unknown;
}

export type Scoped<TClient> = TClient & { $unscoped: () => TClient };
