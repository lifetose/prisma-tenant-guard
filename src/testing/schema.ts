export interface SchemaField {
  name: string;
  type: string;
  isList: boolean;
  optional: boolean;
}

export interface SchemaModel {
  name: string;
  fields: Map<string, SchemaField>;
}

export type SchemaModels = Map<string, SchemaModel>;

const MODEL_OPEN = /^\s*model\s+(\w+)\s*\{/;
const BLOCK_CLOSE = /^\s*\}\s*$/;
const FIELD = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?/;

function stripComment(line: string): string {
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"' && line[index - 1] !== "\\") {
      quoted = !quoted;
      continue;
    }

    if (!quoted && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

export function parseSchema(source: string): SchemaModels {
  const models: SchemaModels = new Map();
  let current: SchemaModel | undefined;

  for (const raw of source.split("\n")) {
    const line = stripComment(raw);

    if (!current) {
      const opened = MODEL_OPEN.exec(line);
      if (opened) current = { name: opened[1]!, fields: new Map() };
      continue;
    }

    if (BLOCK_CLOSE.test(line)) {
      models.set(current.name, current);
      current = undefined;
      continue;
    }

    if (/^\s*@@/.test(line)) continue;

    const field = FIELD.exec(line);
    if (!field) continue;

    current.fields.set(field[1]!, {
      name: field[1]!,
      type: field[2]!,
      isList: field[3] !== undefined,
      optional: field[4] !== undefined,
    });
  }

  return models;
}

export function resolveSchema(schema: string | SchemaModels): SchemaModels {
  return typeof schema === "string" ? parseSchema(schema) : schema;
}

export function relationTarget(
  schema: SchemaModels,
  model: string,
  relation: string,
): string | undefined {
  return schema.get(model)?.fields.get(relation)?.type;
}
