import { randomUUID } from 'node:crypto';

import type { Project } from '@babybot/contracts';

import type { ProjectRepository, ProjectWorkspace } from './ports';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly workspaces: ProjectWorkspace,
  ) {}

  list(): Promise<readonly Project[]> {
    return this.projects.listProjects();
  }

  get(id: string): Promise<Project | undefined> {
    return this.projects.getProject(id);
  }

  async create(name: string): Promise<Project> {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new Error('Project name cannot be empty.');
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
    };

    await this.projects.saveProject(project);
    await this.workspaces.ensure(project.id);
    return project;
  }
}
