import type { ProjectStreamEvent } from '@babybot/contracts';

type ProjectEventListener = (event: ProjectStreamEvent) => void;

export class ProjectEventHub {
  private readonly listeners = new Map<string, Set<ProjectEventListener>>();

  subscribe(projectId: string, listener: ProjectEventListener): () => void {
    const projectListeners = this.listeners.get(projectId) ?? new Set();
    projectListeners.add(listener);
    this.listeners.set(projectId, projectListeners);
    return () => {
      projectListeners.delete(listener);
      if (projectListeners.size === 0) {
        this.listeners.delete(projectId);
      }
    };
  }

  publish(projectId: string, event: ProjectStreamEvent): void {
    for (const listener of this.listeners.get(projectId) ?? []) {
      listener(event);
    }
  }
}
