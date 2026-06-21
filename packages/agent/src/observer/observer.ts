import { AgentRuntimeError } from '../errors';
import type {
  AgentEmission,
  AgentEvent,
  AgentEventListener,
  AgentEventRecorder,
  AgentRecord,
  EmittedAgentEvent,
  Observer,
  RecordedAgentEvent,
} from './interface';

export interface AgentObserverOptions {
  readonly sessionId: string;
  readonly recorder?: AgentEventRecorder;
  readonly now?: () => Date;
}

export class AgentObserver implements Observer {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly now: () => Date;
  private sequence = 0;

  constructor(private readonly options: AgentObserverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async record(event: AgentRecord): Promise<RecordedAgentEvent> {
    const recorded = {
      ...event,
      sessionId: this.options.sessionId,
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
    } as RecordedAgentEvent;

    try {
      await this.options.recorder?.append(recorded);
    } catch (cause) {
      throw new AgentRuntimeError(
        'observer.record_failed',
        `Failed to record agent event ${event.type}.`,
        { cause, details: { eventType: event.type } },
      );
    }

    this.publish(recorded);
    return recorded;
  }

  emit(event: AgentEmission): void {
    const emitted = {
      ...event,
      sessionId: this.options.sessionId,
      timestamp: this.now().toISOString(),
    } as EmittedAgentEvent;
    this.publish(emitted);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // Observation is best-effort after a structural event has been recorded.
      }
    }
  }
}
