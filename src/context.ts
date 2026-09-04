import { AsyncLocalStorage } from "node:async_hooks";

import { TenantContextMissingError } from "./errors.js";
import type { EmptyContext, TenantContext } from "./types.js";

export class TenantStore<
  TScope extends string = string,
  TExtra extends object = EmptyContext,
> {
  private readonly storage = new AsyncLocalStorage<
    TenantContext<TScope, TExtra>
  >();

  constructor(
    private readonly columnOf?: (scope: string) => string | undefined,
  ) {}

  run<T>(context: TenantContext<TScope, TExtra>, callback: () => T): T {
    return this.storage.run({ ...context }, callback);
  }

  current(): TenantContext<TScope, TExtra> | undefined {
    return this.storage.getStore();
  }

  get(scope: TScope): string | undefined {
    return this.storage.getStore()?.[scope] as string | undefined;
  }

  require(scope: TScope): string {
    const id = this.get(scope);
    if (id === undefined) {
      throw new TenantContextMissingError(
        "context",
        "require",
        scope,
        this.columnOf?.(scope) ?? String(scope),
      );
    }

    return id;
  }

  assign(patch: TenantContext<TScope, TExtra>): void {
    const store = this.storage.getStore();
    if (!store) return;
    Object.assign(store, patch);
  }

  exit<T>(callback: () => T): T {
    return this.storage.exit(callback);
  }
}
