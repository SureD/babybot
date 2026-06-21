import { describe, expect, it, vi } from 'vitest';

import { AgentObserver } from '../src/observer';

describe('AgentObserver', () => {
  it('records before publishing and assigns monotonic sequence numbers', async () => {
    const order: string[] = [];
    const observer = new AgentObserver({
      sessionId: 'session-1',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      recorder: {
        append: async (event) => {
          order.push(`record:${String(event.sequence)}`);
        },
      },
    });
    observer.subscribe((event) => {
      if ('sequence' in event) order.push(`publish:${String(event.sequence)}`);
    });

    const first = await observer.record({ type: 'warning', message: 'one' });
    const second = await observer.record({ type: 'warning', message: 'two' });

    expect(order).toEqual(['record:1', 'publish:1', 'record:2', 'publish:2']);
    expect(first).toMatchObject({ sessionId: 'session-1', sequence: 1 });
    expect(second.sequence).toBe(2);
  });

  it('isolates listener failures for records and emissions', async () => {
    const observer = new AgentObserver({ sessionId: 'session-1' });
    const healthyListener = vi.fn();
    observer.subscribe(() => {
      throw new Error('listener failed');
    });
    observer.subscribe(async () => {
      throw new Error('async listener failed');
    });
    observer.subscribe(healthyListener);

    await expect(observer.record({ type: 'warning', message: 'record' }))
      .resolves.toMatchObject({ sequence: 1 });
    expect(() => observer.emit({
      type: 'message.delta',
      turnId: 'turn-1',
      text: 'delta',
    })).not.toThrow();
    expect(healthyListener).toHaveBeenCalledTimes(2);
  });

  it('fails structural recording without publishing the event', async () => {
    const observer = new AgentObserver({
      sessionId: 'session-1',
      recorder: { append: vi.fn().mockRejectedValue(new Error('disk failed')) },
    });
    const listener = vi.fn();
    observer.subscribe(listener);

    await expect(observer.record({ type: 'warning', message: 'lost' }))
      .rejects.toMatchObject({ code: 'observer.record_failed' });
    expect(listener).not.toHaveBeenCalled();
  });
});
