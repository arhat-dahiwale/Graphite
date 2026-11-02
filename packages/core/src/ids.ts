import { customAlphabet } from "nanoid";

// Lowercase alphanumeric without lookalikes (0/O, 1/l/I).
const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const generate = customAlphabet(alphabet, 21);

/**
 * Prefixed, URL-safe ID: `<prefix>_<21 chars>`.
 * Prefixes follow DATA.md: org_, prj_, ds_, dash_, chart_, run_, ...
 */
export function newId(prefix: string): string {
  return `${prefix}_${generate()}`;
}
