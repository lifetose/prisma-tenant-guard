import { TenantStore } from "./context.js";
import { createTenantGuard } from "./extension.js";
import { TenancyRegistry } from "./registry.js";
import type {
  EmptyContext,
  PrismaLike,
  Scoped,
  TenancyConfig,
  TenantContext,
} from "./types.js";

export class Tenancy<
  TScope extends string = string,
  TModel extends string = string,
  TChild extends string = string,
  TExtra extends object = EmptyContext,
> {
  readonly registry: TenancyRegistry;
  readonly store: TenantStore<TScope, TExtra>;

  constructor(config: TenancyConfig<TScope, TModel, TChild>) {
    this.registry = new TenancyRegistry(config as TenancyConfig);
    this.store = new TenantStore<TScope, TExtra>((scope) =>
      this.registry.columnOf(scope),
    );
  }

  withContext<TNext extends object>(): Tenancy<TScope, TModel, TChild, TNext> {
    return this as unknown as Tenancy<TScope, TModel, TChild, TNext>;
  }

  run<T>(context: TenantContext<TScope, TExtra>, callback: () => T): T {
    return this.store.run(context, callback);
  }

  current(): TenantContext<TScope, TExtra> | undefined {
    return this.store.current();
  }

  get(scope: TScope): string | undefined {
    return this.store.get(scope);
  }

  require(scope: TScope): string {
    return this.store.require(scope);
  }

  assign(patch: TenantContext<TScope, TExtra>): void {
    this.store.assign(patch);
  }

  unscoped<T>(callback: () => T): T {
    return this.store.exit(callback);
  }

  extension(base: unknown) {
    return createTenantGuard(this.registry, this.store, base);
  }

  protect<TClient extends PrismaLike>(client: TClient): Scoped<TClient> {
    const extension = this.extension(client) as never;

    return client.$extends(extension) as Scoped<TClient>;
  }
}

export function defineTenancy<
  TScope extends string,
  TModel extends string,
  TChild extends string = never,
>(
  config: TenancyConfig<TScope, TModel, TChild>,
): Tenancy<TScope, TModel, TChild> {
  return new Tenancy(config);
}
