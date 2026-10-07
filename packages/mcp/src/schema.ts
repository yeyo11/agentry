/** The part of JSON Schema the tools use: an object of strings, integers, booleans and lists, with limits */
export interface Schema {
  type: 'object';
  properties: Record<string, Property>;
  required?: string[];
  additionalProperties: false;
}

export interface Property {
  type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  /** A list: what each entry is, and how many there may be */
  items?: Property;
  maxItems?: number;
  /** An object inside a list: its own fields, as strict as the top level */
  properties?: Record<string, Property>;
  required?: string[];
  additionalProperties?: false;
}

/** The problem with an input, or null when it fits the schema */
export function validate(schema: Schema, input: unknown): string | null {
  const value = input ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) return 'arguments must be an object';
  return fields(schema, value as Record<string, unknown>, '');
}

function fields(schema: { properties?: Record<string, Property>; required?: string[] }, args: Record<string, unknown>, at: string): string | null {
  const properties = schema.properties ?? {};
  for (const key of Object.keys(args)) if (!(key in properties)) return `unknown argument: ${at}${key}`;
  for (const key of schema.required ?? []) if (args[key] === undefined) return `${at}${key} is required`;
  for (const [key, prop] of Object.entries(properties)) {
    const v = args[key];
    if (v === undefined) continue;
    const problem = check(prop, v, `${at}${key}`);
    if (problem) return problem;
  }
  return null;
}

function check(prop: Property, v: unknown, key: string): string | null {
  if (prop.type === 'string') {
    if (typeof v !== 'string') return `${key} must be a string`;
    if (prop.minLength !== undefined && v.length < prop.minLength) return `${key} must not be empty`;
    if (prop.maxLength !== undefined && v.length > prop.maxLength) return `${key} is longer than ${prop.maxLength} characters`;
    if (prop.pattern && !new RegExp(prop.pattern).test(v)) return `${key} does not match ${prop.pattern}`;
    if (prop.enum && !prop.enum.includes(v)) return `${key} must be one of ${prop.enum.join(', ')}`;
  } else if (prop.type === 'integer') {
    if (typeof v !== 'number' || !Number.isInteger(v)) return `${key} must be a whole number`;
    if (prop.minimum !== undefined && v < prop.minimum) return `${key} must be at least ${prop.minimum}`;
    if (prop.maximum !== undefined && v > prop.maximum) return `${key} must be at most ${prop.maximum}`;
  } else if (prop.type === 'array') {
    if (!Array.isArray(v)) return `${key} must be a list`;
    if (prop.maxItems !== undefined && v.length > prop.maxItems) return `${key} has more than ${prop.maxItems} entries`;
    if (prop.items) {
      for (const [i, entry] of v.entries()) {
        const problem = check(prop.items, entry, `${key}[${i}]`);
        if (problem) return problem;
      }
    }
  } else if (prop.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${key} must be an object`;
    return fields(prop, v as Record<string, unknown>, `${key}.`);
  } else if (typeof v !== 'boolean') return `${key} must be true or false`;
  return null;
}
