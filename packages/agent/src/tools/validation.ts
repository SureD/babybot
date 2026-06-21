import type { JsonObject } from '../content';

export interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

export function validateJsonSchema(
  schema: JsonObject,
  value: unknown,
): ValidationFailure | undefined {
  return validate(schema, value, '$');
}

function validate(
  schema: JsonObject,
  value: unknown,
  path: string,
): ValidationFailure | undefined {
  if (schema['const'] !== undefined && !deepEqual(value, schema['const'])) {
    return { path, message: 'must equal the schema const value' };
  }
  if (Array.isArray(schema['enum']) &&
      !schema['enum'].some((candidate) => deepEqual(value, candidate))) {
    return { path, message: 'must be one of the schema enum values' };
  }

  const type = schema['type'];
  if (typeof type === 'string' && !matchesType(type, value)) {
    return { path, message: `must be ${type}` };
  }

  if (isObject(value)) {
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          return { path: `${path}.${key}`, message: 'is required' };
        }
      }
    }

    const properties = isObject(schema['properties'])
      ? schema['properties']
      : {};
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isObject(propertySchema)) {
        const failure = validate(propertySchema, propertyValue, `${path}.${key}`);
        if (failure !== undefined) return failure;
      } else if (schema['additionalProperties'] === false) {
        return { path: `${path}.${key}`, message: 'is not allowed' };
      } else if (isObject(schema['additionalProperties'])) {
        const failure = validate(
          schema['additionalProperties'],
          propertyValue,
          `${path}.${key}`,
        );
        if (failure !== undefined) return failure;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      return { path, message: `must contain at least ${String(schema['minItems'])} items` };
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      return { path, message: `must contain at most ${String(schema['maxItems'])} items` };
    }
    const itemSchema = schema['items'];
    if (isObject(itemSchema)) {
      for (const [index, item] of value.entries()) {
        const failure = validate(itemSchema, item, `${path}[${String(index)}]`);
        if (failure !== undefined) return failure;
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      return { path, message: `must contain at least ${String(schema['minLength'])} characters` };
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      return { path, message: `must contain at most ${String(schema['maxLength'])} characters` };
    }
    if (typeof schema['pattern'] === 'string') {
      try {
        if (!new RegExp(schema['pattern']).test(value)) {
          return { path, message: `must match ${schema['pattern']}` };
        }
      } catch {
        return { path, message: 'uses an invalid schema pattern' };
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      return { path, message: `must be at least ${String(schema['minimum'])}` };
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      return { path, message: `must be at most ${String(schema['maximum'])}` };
    }
  }

  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'null': return value === null;
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'object': return isObject(value);
    case 'string': return typeof value === 'string';
    default: return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
}
