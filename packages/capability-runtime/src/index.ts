import type {
  CapabilityMatch,
  CapabilityResult,
  CapabilityRuntime,
} from '@babybot/core';

export class LocalCapabilityRuntime implements CapabilityRuntime {
  async find(_projectId: string, _input: string): Promise<CapabilityMatch | undefined> {
    return undefined;
  }

  async run(
    _match: CapabilityMatch,
    _projectId: string,
    _input: string,
  ): Promise<CapabilityResult> {
    throw new Error('Capability execution is not implemented yet.');
  }
}

