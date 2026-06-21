import { AgentRuntimeError } from '../errors';
import type { TurnInput } from '../content';
import type { PromptInjection } from '../prompter/interface';
import type {
  Context,
  ContextSnapshot,
  ContextStore,
  PreparedContext,
} from './interface';

export class AgentContext implements Context {
  private logicalRevision = 0;

  constructor(private readonly store: ContextStore) {}

  async snapshot(): Promise<ContextSnapshot> {
    try {
      const snapshot = await this.store.snapshot();
      this.logicalRevision = Math.max(this.logicalRevision, snapshot.revision);
      return freezeSnapshot({
        ...snapshot,
        revision: this.logicalRevision,
      });
    } catch (cause) {
      throw new AgentRuntimeError(
        'context.failed',
        'Failed to read the agent context.',
        { cause },
      );
    }
  }

  async prepare(
    input: TurnInput,
    injections: readonly PromptInjection[],
  ): Promise<PreparedContext> {
    const snapshot = await this.snapshot();
    const prefixes = injections
      .filter(({ position }) => position === 'turn-prefix')
      .map(({ text }) => text);
    const suffixes = injections
      .filter(({ position }) => position === 'turn-suffix')
      .map(({ text }) => text);
    const preparedInput = Object.freeze({
      text: [...prefixes, input.text, ...suffixes].join('\n\n'),
    });
    return Object.freeze({
      revision: snapshot.revision,
      input: preparedInput,
      systemAppend: Object.freeze(
        injections
          .filter(({ position }) => position === 'system-append')
          .map(({ text }) => text),
      ),
    });
  }

  async compact(instruction?: string): Promise<void> {
    await this.mutate('compact', instruction);
  }

  async clear(): Promise<void> {
    await this.mutate('clear');
  }

  private async mutate(
    operation: 'compact' | 'clear',
    instruction?: string,
  ): Promise<void> {
    try {
      const before = await this.store.snapshot();
      this.logicalRevision = Math.max(this.logicalRevision, before.revision);
      if (operation === 'compact') await this.store.compact(instruction);
      else await this.store.clear();
      this.logicalRevision += 1;
    } catch (cause) {
      throw new AgentRuntimeError(
        'context.failed',
        `Failed to ${operation} the agent context.`,
        { cause, details: { operation } },
      );
    }
  }
}

function freezeSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  const cloned = structuredClone(snapshot);
  for (const entry of cloned.entries) deepFreeze(entry);
  if (cloned.usage !== undefined) Object.freeze(cloned.usage);
  Object.freeze(cloned.entries);
  return Object.freeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
