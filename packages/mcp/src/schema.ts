/** The part of JSON Schema the tools use: an object of strings, integers and booleans, with limits */
export interface Schema {
  type: 'object';
  properties: Record<string, Property>;
  required?: string[];
  additionalProperties: false;
}

export interface Property {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
}

/** The problem with an input, or null when it fits the schema */
export function validate(schema: Schema, input: unknown): string | null {
  const value = input ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) return 'arguments must be an object';
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args)) if (!(key in schema.properties)) return `unknown argument: ${key}`;
  for (const key of schema.required ?? []) if (args[key] === undefined) return `${key} is required`;
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
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
    } else if (typeof v !== 'boolean') return `${key} must be true or false`;
  }
  return null;
}
