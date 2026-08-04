import { Task } from '../models/task';

export class TaskRepository {
  private readonly tasks = new Map<string, Task>();

  save(task: Task): void {
    this.tasks.set(task.id, task);
  }

  findById(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }
}
