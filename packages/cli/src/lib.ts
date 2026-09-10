/**
 * The public entry point of the `bookrail` package.
 *
 * `import { defineConfig } from 'bookrail'` in a `bookrail.config.ts` resolves here. The API
 * client, the config schema and the plan builder are exported too, because the MCP server
 * mounts them in process rather than shelling out to the binary.
 */
export { defineConfig } from './config/define.js';
export type { BookrailConfigInput, BookrailConfig, EntityKind } from './config/schema.js';
export { configSchema, entrySchemas, ENTITY_KINDS } from './config/schema.js';
export { validateConfig, assertValidConfig, PUSH_ORDER } from './config/normalize.js';
export type { NormalizedConfig, ConfigIssue } from './config/normalize.js';
export { loadConfig, findConfigFile, CONFIG_FILE_NAMES } from './config/load.js';
export { toJsonSchema, toRootJsonSchema } from './config/json-schema.js';
export { ApiClient } from './api/client.js';
export type { ApiClientOptions, ApiResponse, ListEnvelope } from './api/client.js';
export { apiErrorToCliError } from './api/errors.js';
// The MCP server has its own test/live barrier to enforce (a live key needs
// `BOOKRAIL_MCP_ALLOW_LIVE`, which the CLI knows nothing about) and it has to read the same
// credentials file and recognise the same key prefixes. Exporting these four is what keeps it
// from growing a second copy of them.
export { loadCredentials, credentialsPath, environmentOfKey, maskKey } from './credentials.js';
export type { CredentialsFile, LoadedCredentials } from './credentials.js';
export { CliError, EXIT } from './errors.js';
export type { ExitCode, CliErrorBody } from './errors.js';
export { buildPlan, fetchRemoteState } from './sync/plan.js';
export type { Plan, PlanItem, RemoteState } from './sync/plan.js';
export { applyPlan } from './sync/apply.js';
export { pullConfig } from './sync/pull.js';
export { renderConfigFile } from './render.js';
export { TEMPLATES, TEMPLATE_NAMES } from './templates/index.js';
export type { Template } from './templates/index.js';
// The one list of the collections `bookrail <entity>` and the MCP's `bookrail_object_*` tools
// act on. Exported here so the MCP server takes it instead of keeping a copy.
export { OBJECT_KINDS, ENTITIES, entityByCommand } from './commands/crud.js';
export type { ObjectKind, EntityDescriptor } from './commands/crud.js';
export { run } from './run.js';
export { processIo } from './io.js';
export type { Io } from './io.js';
export { CLI_VERSION, API_VERSION, DEFAULT_API_URL } from './version.js';
