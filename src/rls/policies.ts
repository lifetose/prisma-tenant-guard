import type { Tenancy } from "../tenancy.js";
import {
  applyNaming,
  NamingStrategy,
  quoteIdentifier,
  quoteLiteral,
} from "./naming.js";
import { defaultSettingName, SettingNamer } from "./settings.js";

export type ScopeCast = "text" | "uuid" | "integer" | "bigint" | "none";

export interface ChildJoin {
  table?: string;
  foreignKey: string;
  parentTable?: string;
  parentKey?: string;
}

export interface RlsOptions {
  naming?: NamingStrategy;
  tables?: Record<string, string>;
  columns?: Record<string, string>;
  settingName?: SettingNamer;
  cast?: ScopeCast;
  policyName?: string;
  force?: boolean;
  children?: Record<string, ChildJoin>;
}

export interface RlsPolicy {
  model: string;
  table: string;
  scope: string;
  policy: string;
  statements: string[];
}

export interface RlsGap {
  model: string;
  kind: "child" | "unknown";
  reason: string;
}

export interface RlsPlan {
  policies: RlsPolicy[];
  gaps: RlsGap[];
  statements: string[];
  sql: string;
  covered: string[];
  uncovered: string[];
}

const DEFAULT_POLICY_NAME = "tenant_isolation";

function settingExpression(name: string): string {
  return `nullif(current_setting(${quoteLiteral(name)}, true), '')`;
}

function comparison(
  column: string,
  settingName: string,
  cast: ScopeCast,
): string {
  const setting = settingExpression(settingName);
  const left = quoteIdentifier(column);

  if (cast === "none") {
    return `${left} = ${setting}`;
  }

  if (cast === "text") {
    return `${left}::text = ${setting}`;
  }

  return `${left} = ${setting}::${cast}`;
}

function tableFor(
  model: string,
  options: RlsOptions,
  naming: NamingStrategy,
): string {
  return options.tables?.[model] ?? applyNaming(model, naming);
}

function columnFor(
  scope: string,
  fallback: string,
  options: RlsOptions,
  naming: NamingStrategy,
): string {
  return options.columns?.[scope] ?? applyNaming(fallback, naming);
}

function tableStatements(
  table: string,
  policy: string,
  predicate: string,
  force: boolean,
): string[] {
  const quoted = quoteIdentifier(table);
  const statements = [`ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY;`];

  if (force) {
    statements.push(`ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY;`);
  }

  statements.push(
    `DROP POLICY IF EXISTS ${quoteIdentifier(policy)} ON ${quoted};`,
    `CREATE POLICY ${quoteIdentifier(policy)} ON ${quoted}\n` +
      `  USING (${predicate})\n` +
      `  WITH CHECK (${predicate});`,
  );

  return statements;
}

export function generateRls(
  tenancy: Pick<Tenancy, "registry">,
  options: RlsOptions = {},
): RlsPlan {
  const naming = options.naming ?? "preserve";
  const namer = options.settingName ?? defaultSettingName;
  const cast = options.cast ?? "text";
  const policyName = options.policyName ?? DEFAULT_POLICY_NAME;
  const force = options.force ?? true;

  const policies: RlsPolicy[] = [];
  const gaps: RlsGap[] = [];

  for (const entry of tenancy.registry.tenantModels.values()) {
    const table = tableFor(entry.model, options, naming);
    const column = columnFor(entry.scope, entry.column, options, naming);
    const predicate = comparison(column, namer(entry.scope), cast);

    policies.push({
      model: entry.model,
      table,
      scope: entry.scope,
      policy: policyName,
      statements: tableStatements(table, policyName, predicate, force),
    });
  }

  for (const entry of tenancy.registry.childModels.values()) {
    const join = options.children?.[entry.model];

    if (!join) {
      gaps.push({
        model: entry.model,
        kind: "child",
        reason:
          `"${entry.model}" reaches its tenant through "${entry.through}", so a ` +
          "policy needs the foreign key that links them. Declare it under " +
          "children, or the database will not enforce this model.",
      });

      continue;
    }

    const table = join.table ?? tableFor(entry.model, options, naming);
    const parentTable =
      join.parentTable ?? tableFor(entry.through, options, naming);
    const parentKey = join.parentKey ?? "id";
    const column = columnFor(entry.scope, entry.column, options, naming);

    const predicate =
      `EXISTS (\n` +
      `    SELECT 1 FROM ${quoteIdentifier(parentTable)} AS parent\n` +
      `    WHERE parent.${quoteIdentifier(parentKey)} = ` +
      `${quoteIdentifier(table)}.${quoteIdentifier(join.foreignKey)}\n` +
      `      AND parent.${comparison(column, namer(entry.scope), cast)}\n` +
      `  )`;

    policies.push({
      model: entry.model,
      table,
      scope: entry.scope,
      policy: policyName,
      statements: tableStatements(table, policyName, predicate, force),
    });
  }

  const statements = policies.flatMap((policy) => policy.statements);

  return {
    policies,
    gaps,
    statements,
    sql: statements.join("\n") + (statements.length ? "\n" : ""),
    covered: policies.map((policy) => policy.model),
    uncovered: gaps.map((gap) => gap.model),
  };
}

export function formatGaps(gaps: readonly RlsGap[]): string {
  return gaps.map((gap) => `- ${gap.reason}`).join("\n");
}

export function assertRlsCoverage(plan: RlsPlan): void {
  if (plan.gaps.length === 0) return;

  throw new Error(
    `prisma-tenant-guard cannot write a policy for ${plan.gaps.length} model(s):\n${formatGaps(
      plan.gaps,
    )}`,
  );
}
