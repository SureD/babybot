import { AgentRuntimeError } from '../errors';
import type { JsonObject } from '../content';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolFilter,
  ToolHandler,
  ToolRegistration,
  ToolResult,
  Tools,
  ToolSnapshot,
  ToolCall,
} from './interface';
import { validateJsonSchema } from './validation';

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly execute?: ToolHandler;
}

export interface AgentToolsOptions {
  readonly registrations?: readonly ToolRegistration[];
}

export class AgentTools implements Tools {
  private readonly registry = new Map<string, RegisteredTool>();
  private currentRevision = 0;

  constructor(options: AgentToolsOptions = {}) {
    for (const registration of options.registrations ?? []) {
      this.register(registration);
    }
  }

  register(tool: ToolRegistration): void {
    this.assertRegistration(tool);
    if (this.registry.has(tool.name)) {
      throw this.registrationConflict(tool.name, 'is already registered');
    }
    this.registry.set(tool.name, this.toRegisteredTool(tool));
    this.currentRevision += 1;
  }

  replace(tool: ToolRegistration): void {
    this.assertRegistration(tool);
    const existing = this.registry.get(tool.name);
    if (existing === undefined) {
      throw this.notFound(tool.name);
    }
    if (existing.definition.lifetime === 'static' || tool.lifetime !== 'dynamic') {
      throw this.registrationConflict(
        tool.name,
        'cannot replace a static tool or replace it with a static registration',
      );
    }
    this.registry.set(tool.name, this.toRegisteredTool(tool));
    this.currentRevision += 1;
  }

  unregister(name: string): boolean {
    const existing = this.registry.get(name);
    if (existing === undefined) return false;
    if (existing.definition.lifetime === 'static') {
      throw this.registrationConflict(name, 'is static and cannot be removed');
    }
    this.registry.delete(name);
    this.currentRevision += 1;
    return true;
  }

  enable(name: string): void {
    this.setEnabled(name, true);
  }

  disable(name: string): void {
    this.setEnabled(name, false);
  }

  get(name: string): ToolDefinition | undefined {
    return this.registry.get(name)?.definition;
  }

  list(): readonly ToolDefinition[] {
    return Object.freeze([...this.registry.values()].map(({ definition }) => definition));
  }

  snapshot(filter?: ToolFilter): ToolSnapshot {
    const tools = [...this.registry.values()]
      .map(({ definition }) => definition)
      .filter((definition) => definition.enabled && (filter?.(definition) ?? true));
    return Object.freeze({
      revision: this.currentRevision,
      tools: Object.freeze(tools),
    });
  }

  async invoke(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (tool === undefined || !tool.definition.enabled || tool.execute === undefined) {
      throw this.notFound(call.name);
    }
    const failure = validateJsonSchema(tool.definition.inputSchema, call.arguments);
    if (failure !== undefined) {
      throw new AgentRuntimeError(
        'tool.invalid_input',
        `Invalid input for tool ${call.name}: ${failure.path} ${failure.message}.`,
        {
          details: {
            name: call.name,
            path: failure.path,
            reason: failure.message,
          },
        },
      );
    }
    context.signal.throwIfAborted();
    return tool.execute(call.arguments, context);
  }

  private setEnabled(name: string, enabled: boolean): void {
    const existing = this.registry.get(name);
    if (existing === undefined) throw this.notFound(name);
    if (existing.definition.enabled === enabled) return;
    this.registry.set(name, {
      ...existing,
      definition: Object.freeze({ ...existing.definition, enabled }),
    });
    this.currentRevision += 1;
  }

  private toRegisteredTool(tool: ToolRegistration): RegisteredTool {
    const inputSchema = cloneAndFreeze(tool.inputSchema);
    const definition = Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema,
      source: tool.source,
      version: tool.version,
      lifetime: tool.lifetime,
      readOnly: tool.readOnly,
      execution: tool.execution,
      enabled: tool.enabled ?? true,
    });
    return tool.execution === 'hosted'
      ? { definition, execute: tool.execute }
      : { definition };
  }

  private assertRegistration(tool: ToolRegistration): void {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tool.name)) {
      throw new TypeError(`Invalid tool name: ${JSON.stringify(tool.name)}.`);
    }
    if (tool.description.trim() === '') {
      throw new TypeError(`Tool ${tool.name} must have a description.`);
    }
    if (tool.version.trim() === '') {
      throw new TypeError(`Tool ${tool.name} must have a version.`);
    }
  }

  private registrationConflict(name: string, reason: string): AgentRuntimeError {
    return new AgentRuntimeError(
      'tool.registration_conflict',
      `Tool ${name} ${reason}.`,
      { details: { name, reason } },
    );
  }

  private notFound(name: string): AgentRuntimeError {
    return new AgentRuntimeError(
      'tool.not_found',
      `Tool ${name} is not registered as an enabled hosted tool.`,
      { details: { name } },
    );
  }
}

function cloneAndFreeze(value: JsonObject): JsonObject {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
