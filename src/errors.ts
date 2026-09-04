export type TenancyErrorCode =
  | "TENANT_CONTEXT_MISSING"
  | "TENANT_MISMATCH"
  | "TENANT_MODEL_UNKNOWN"
  | "TENANT_CONFIG_INVALID";

export abstract class TenancyError extends Error {
  abstract readonly code: TenancyErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class TenantContextMissingError extends TenancyError {
  readonly code = "TENANT_CONTEXT_MISSING" as const;

  constructor(
    readonly model: string,
    readonly operation: string,
    readonly scope: string,
    readonly column: string,
  ) {
    super(
      `${model}.${operation} needs a tenant context carrying "${scope}" (column ${column})`,
    );
  }
}

export class TenantMismatchError extends TenancyError {
  readonly code = "TENANT_MISMATCH" as const;

  constructor(
    readonly model: string,
    readonly column: string,
    readonly expected: string,
    readonly received: unknown,
  ) {
    super(
      `${model}.${column} was addressed as ${JSON.stringify(received)} while the tenant context holds ${expected}`,
    );
  }
}

export class UnknownTenantModelError extends TenancyError {
  readonly code = "TENANT_MODEL_UNKNOWN" as const;

  constructor(readonly model: string) {
    super(`${model} is not classified by this tenancy registry`);
  }
}

export class TenancyConfigError extends TenancyError {
  readonly code = "TENANT_CONFIG_INVALID" as const;
}
