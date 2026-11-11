/**
 * The assistant's tool registry. Every feature a person can use in the editor is also registered
 * here, so the assistant operates the application through the same command layer as the UI.
 */

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  additionalProperties?: boolean | JsonSchema;
}

/** A tool may return an image (the `look` tool) alongside its text result. */
export interface ToolOutput {
  result: unknown;
  image?: string;
}

export interface AiTool {
  name: string;
  description: string;
  parameters: JsonSchema & { type: 'object' };
  /** True when the tool changes the project (subject to approval in ask-first mode). */
  mutates: boolean;
  /** Short human-readable summary of a call, shown in the chat and the undo history. */
  summarize?: (args: any) => string;
  run: (args: any) => unknown | ToolOutput | Promise<unknown | ToolOutput>;
}

const tools = new Map<string, AiTool>();

export function registerTool(tool: AiTool): void {
  tools.set(tool.name, tool);
}

export function listTools(): AiTool[] {
  return [...tools.values()];
}

export function getTool(name: string): AiTool | undefined {
  return tools.get(name);
}

/** Minimal JSON-schema check. Returns an error message, or null when the value conforms. */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (obj[key] === undefined || obj[key] === null) return `${path}.${key} is required`;
      for (const key in schema.properties ?? {}) {
        if (obj[key] === undefined || obj[key] === null) continue;
        const err = validate(schema.properties![key], obj[key], `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validate(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${path} must be a string`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? null : `${path} must be a whole number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
    default:
      return null;
  }
}

export function isToolOutput(v: unknown): v is ToolOutput {
  return typeof v === 'object' && v !== null && 'result' in v && ('image' in v || Object.keys(v).length === 1);
}
