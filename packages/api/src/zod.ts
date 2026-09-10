/**
 * The project's Zod, extended once with `.openapi()`.
 *
 * `@asteasolutions/zod-to-openapi` carries the OpenAPI metadata **on the schema**, which is
 * the whole point of generating the specification from the schemas rather than writing it
 * next to them: a `description` or a `pattern` lives where the validation lives and cannot be
 * forgotten when the validation changes. The extension patches `ZodType.prototype`, so it has
 * to run **before** any module-level `.openapi(...)` call: importing `z` from here rather
 * than from `zod` is what guarantees the order.
 *
 * Every module of `@bookrail/api` that declares a schema imports `z` from here. Modules that
 * only *use* a schema may keep importing `zod` directly: the prototype is shared.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export { z };
