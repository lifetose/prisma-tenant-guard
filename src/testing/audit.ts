import type { TenancyRegistry } from "../registry.js";
import {
  resolveSchema,
  type SchemaField,
  type SchemaModels,
} from "./schema.js";

export type AuditFinding =
  | { kind: "unclassified"; model: string }
  | { kind: "duplicate"; model: string }
  | { kind: "stale"; model: string }
  | { kind: "missing-column"; model: string; column: string }
  | { kind: "unknown-relation"; model: string; on: string; relation: string }
  | { kind: "list-relation"; model: string; on: string; relation: string }
  | { kind: "wrong-terminus"; model: string; expected: string; actual: string };

export interface AuditableTenancy {
  readonly registry: TenancyRegistry;
}

export interface AuditInput {
  schema: string | SchemaModels;
  models?: readonly string[];
}

function findingMessage(finding: AuditFinding): string {
  switch (finding.kind) {
    case "unclassified":
      return `${finding.model} is in the schema but is not classified as tenant-scoped, a child, or global`;
    case "duplicate":
      return `${finding.model} is classified more than once`;
    case "stale":
      return `${finding.model} is classified but no longer exists in the schema`;
    case "missing-column":
      return `${finding.model} is tenant-scoped but has no ${finding.column} column`;
    case "unknown-relation":
      return `${finding.model} routes through "${finding.relation}", which ${finding.on} does not have`;
    case "list-relation":
      return `${finding.model} routes through "${finding.relation}" on ${finding.on}, which is a list, not a parent`;
    case "wrong-terminus":
      return `${finding.model} claims to route through ${finding.expected} but its path ends at ${finding.actual}`;
  }
}

export function formatFindings(findings: readonly AuditFinding[]): string {
  return findings.map((finding) => `- ${findingMessage(finding)}`).join("\n");
}

export function auditTenancy(
  tenancy: AuditableTenancy,
  input: AuditInput,
): AuditFinding[] {
  const schema = resolveSchema(input.schema);
  const schemaModels = input.models ?? [...schema.keys()];
  const registry = tenancy.registry;
  const findings: AuditFinding[] = [];

  for (const model of schemaModels) {
    if (!registry.classify(model))
      findings.push({ kind: "unclassified", model });
  }

  const classified = registry.classified();
  const seen = new Set<string>();
  for (const model of classified) {
    if (seen.has(model)) findings.push({ kind: "duplicate", model });
    seen.add(model);
  }

  const known = new Set(schemaModels);
  for (const model of seen) {
    if (!known.has(model)) findings.push({ kind: "stale", model });
  }

  for (const entry of registry.tenantModels.values()) {
    const fields = schema.get(entry.model)?.fields;
    if (!fields) continue;

    if (!fields.has(entry.column)) {
      findings.push({
        kind: "missing-column",
        model: entry.model,
        column: entry.column,
      });
    }
  }

  for (const child of registry.childModels.values()) {
    let current: string | undefined = child.model;
    let broken = false;

    for (const relation of child.path) {
      const field: SchemaField | undefined = current
        ? schema.get(current)?.fields.get(relation)
        : undefined;

      if (!field) {
        findings.push({
          kind: "unknown-relation",
          model: child.model,
          on: current ?? child.model,
          relation,
        });
        broken = true;
        break;
      }

      if (field.isList) {
        findings.push({
          kind: "list-relation",
          model: child.model,
          on: current ?? child.model,
          relation,
        });
        broken = true;
        break;
      }

      current = field.type;
    }

    if (broken || current === child.through) continue;

    findings.push({
      kind: "wrong-terminus",
      model: child.model,
      expected: child.through,
      actual: current ?? "nothing",
    });
  }

  return findings;
}

export function assertTenancy(
  tenancy: AuditableTenancy,
  input: AuditInput,
): void {
  const findings = auditTenancy(tenancy, input);
  if (findings.length === 0) return;

  throw new Error(
    `prisma-tenant-guard found ${findings.length} classification problem(s):\n${formatFindings(findings)}`,
  );
}
