/**
 * Only one dated API version exists so far, and it is the only value the server accepts: any
 * other date answers `unsupported_api_version`. A new one appears only for a change that breaks
 * compatibility; compatible additions (new fields, new endpoints) never change it.
 */
export const CURRENT_API_VERSION = '2026-09-01';

export const SUPPORTED_API_VERSIONS: readonly string[] = [CURRENT_API_VERSION];

export const API_VERSION_HEADER = 'Bookrail-Version';
export const REQUEST_ID_HEADER = 'Bookrail-Request-Id';

export function isSupportedApiVersion(value: string): boolean {
  return SUPPORTED_API_VERSIONS.includes(value);
}

export const ENVIRONMENTS = ['test', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function isEnvironment(value: string): value is Environment {
  return value === 'test' || value === 'live';
}
