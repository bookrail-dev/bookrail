import { z } from 'zod';

/**
 * A JSON Schema (draft 2020-12) for the subset of Zod this package uses.
 *
 * Written here rather than taken from `zod-to-json-schema` because this package keeps to a
 * very small set of runtime dependencies and because the subset is closed: every schema converted by this
 * function lives in `config/schema.ts`, so an unsupported node is a bug in this file, not an
 * unknown from the ecosystem, and {@link toJsonSchema} throws on one instead of emitting an
 * empty `{}` that would silently accept anything.
 */
export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

/** A named top-level schema, with `$schema` and `title`. */
export function toRootJsonSchema(schema: z.ZodTypeAny, title: string): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    ...convert(schema),
  };
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  const description = (schema.description ?? undefined) as string | undefined;
  const described = (result: JsonSchema): JsonSchema =>
    description === undefined ? result : { ...result, description };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return described(stringSchema(def));
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return described(numberSchema(def));
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return described({ type: 'boolean' });
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return described({ const: def.value });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return described({ type: 'string', enum: [...(def.values as string[])] });
    case z.ZodFirstPartyTypeKind.ZodArray:
      return described(arraySchema(def));
    case z.ZodFirstPartyTypeKind.ZodObject:
      return described(objectSchema(schema as z.ZodObject<z.ZodRawShape>));
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return described({
        type: 'object',
        additionalProperties: convert(def.valueType as z.ZodTypeAny),
      });
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return described({
        anyOf: (def.options as z.ZodTypeAny[]).map((option) => convert(option)),
      });
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return convert(def.innerType as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = convert(def.innerType as z.ZodTypeAny);
      return { anyOf: [inner, { type: 'null' }] };
    }
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = convert(def.innerType as z.ZodTypeAny);
      return { ...inner, default: (def.defaultValue as () => unknown)() };
    }
    case z.ZodFirstPartyTypeKind.ZodEffects:
      // `.refine()` and `.transform()` both land here. The shape a caller has to produce is
      // the inner one; the refinement is a constraint JSON Schema cannot express, and saying
      // nothing about it is honest, whereas dropping the whole node would not be.
      return convert(def.schema as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return {};
    default:
      throw new Error(`toJsonSchema: unsupported Zod node ${def.typeName}`);
  }
}

interface Check {
  kind: string;
  value?: unknown;
  regex?: RegExp;
  /** `positive()` is `min` with `inclusive: false`, which is `exclusiveMinimum` here. */
  inclusive?: boolean;
}

function stringSchema(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of (def.checks as Check[] | undefined) ?? []) {
    if (check.kind === 'min') out.minLength = check.value;
    if (check.kind === 'max') out.maxLength = check.value;
    if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
    if (check.kind === 'email') out.format = 'email';
  }
  return out;
}

function numberSchema(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of (def.checks as Check[] | undefined) ?? []) {
    if (check.kind === 'int') out.type = 'integer';
    if (check.kind === 'min') {
      if (check.inclusive === false) out.exclusiveMinimum = check.value;
      else out.minimum = check.value;
    }
    if (check.kind === 'max') {
      if (check.inclusive === false) out.exclusiveMaximum = check.value;
      else out.maximum = check.value;
    }
  }
  return out;
}

function arraySchema(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = { type: 'array', items: convert(def.type as z.ZodTypeAny) };
  const min = def.minLength as { value: number } | null;
  const max = def.maxLength as { value: number } | null;
  if (min) out.minItems = min.value;
  if (max) out.maxItems = max.value;
  return out;
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    if (!value.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  const unknownKeys = (schema._def as { unknownKeys?: string }).unknownKeys;
  out.additionalProperties = unknownKeys === 'strict' ? false : true;
  return out;
}
