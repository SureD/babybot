import { describe, expect, it } from 'vitest';

import { ProjectToolRuntime } from '../src';

describe('ProjectToolRuntime', () => {
  it('enables the minimal project-owned coding toolset', async () => {
    const runtime = new ProjectToolRuntime();

    await expect(
      runtime.resolve({ projectId: 'project-1', workDir: '/tmp/project-1' }),
    ).resolves.toEqual([
      { name: 'read', source: 'builtin', enabled: true },
      { name: 'write', source: 'builtin', enabled: true },
      { name: 'edit', source: 'builtin', enabled: true },
      { name: 'bash', source: 'builtin', enabled: true },
    ]);
  });
});
