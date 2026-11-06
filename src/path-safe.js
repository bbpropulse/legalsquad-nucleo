import { resolve, sep } from 'node:path';

// Resource ids are filesystem path segments. Restricting them to a strict
// charset is the path-traversal guard: '..', '/', '\\' and '.' are rejected,
// so an id can never escape its parent directory.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function validateId(id, label = 'id') {
  if (!isValidId(id)) {
    throw new Error(`Invalid ${label}: '${id}'`);
  }
}

// True when `childPath` resolves to the same location as `parentPath` or sits
// inside it. Used to skip self-copies (e.g. running init from inside the repo).
export function isPathInsideOrEqual(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  return child === parent || child.startsWith(parent + sep);
}
