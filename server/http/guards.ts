import { HttpError } from './protocol.js';

/** Validation for JSON request bodies. Absent fields are allowed; wrongly typed fields are a 400. */

export type Body = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** An object body; an empty body reads as `{}`. */
export function objectBody(raw: unknown): Body {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new HttpError(400, 'Request body must be a JSON object.');
  return raw;
}

/** A body that must be present (an empty write must never replace saved data). */
export function requiredBody(raw: unknown): unknown {
  if (raw === undefined) throw new HttpError(400, 'Request body is required.');
  return raw;
}

const label = (key: string) => key.replace(/_/g, ' ');

export function optionalText(body: Body, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `The ${label(key)} must be text.`);
  return value;
}

export const text = (body: Body, key: string, fallback = '') => optionalText(body, key) ?? fallback;

export function requiredText(body: Body, key: string, message: string): string {
  const value = optionalText(body, key);
  if (!value?.trim()) throw new HttpError(400, message);
  return value;
}

/** Only a literal `true` enables an option. */
export const flag = (body: Body, key: string) => body[key] === true;

export function optionalNumber(body: Body, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `The ${label(key)} must be a number.`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new HttpError(400, message);
  return value as T;
}
