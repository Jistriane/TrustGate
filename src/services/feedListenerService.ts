import { FeedTick, TaskFeedService } from './taskFeedService';

/**
 * Simulates an executor listening to the marketplace's task feed:
 * subscribes to `tick` events and logs each newly published task.
 */
export class FeedListenerService {
  private readonly handleTick = (tick: FeedTick): void => {
    console.log(
      `[Feed Listener] received tick #${tick.sequence} — new task available: ${tick.taskId}`,
    );
  };

  constructor(private readonly feedService: TaskFeedService) {
    this.feedService.on('tick', this.handleTick);
  }

  stop(): void {
    this.feedService.off('tick', this.handleTick);
  }
}
