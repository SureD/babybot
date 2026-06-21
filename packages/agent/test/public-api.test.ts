import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentMode,
  AgentSession,
  CreateAgentSessionOptions,
  ToolRegistration,
  Turn,
  TurnInput,
  TurnResult,
} from '../src';
import type { BackendSession } from '../src/backend';
import type { Context } from '../src/context';
import type { Observer } from '../src/observer';
import type { Permission } from '../src/permission';
import type { Prompter } from '../src/prompter';
import type { Tools } from '../src/tools';

describe('@babybot/agent contracts', () => {
  it('keeps the public lifecycle centered on Session and Turn', () => {
    expectTypeOf<AgentMode>().toEqualTypeOf<'default' | 'plan' | 'build'>();
    expectTypeOf<AgentSession['prompt']>().toEqualTypeOf<
      (input: TurnInput) => Promise<Turn>
    >();
    expectTypeOf<CreateAgentSessionOptions['workDir']>().toEqualTypeOf<string>();
    expectTypeOf<Turn['result']>().toEqualTypeOf<Promise<TurnResult>>();
    expectTypeOf<ToolRegistration>().toBeObject();
    expectTypeOf<BackendSession['run']>().returns.toMatchTypeOf<
      AsyncIterable<unknown>
    >();
    expectTypeOf<Context>().toBeObject();
    expectTypeOf<Observer>().toBeObject();
    expectTypeOf<Permission>().toBeObject();
    expectTypeOf<Prompter>().toBeObject();
    expectTypeOf<Tools>().toBeObject();
    expect(true).toBe(true);
  });
});
