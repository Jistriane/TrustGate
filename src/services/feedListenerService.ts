import { FeedTick, TaskFeedService } from './taskFeedService';
import { logger } from '../config/logger';

/**
 * Simulates an executor listening to the marketplace's task feed:
 * subscribes to `tick` events and logs each newly published task.
 */
export class FeedListenerService {
  private readonly handleTick = (tick: FeedTick): void => {
    logger.info(
      { sequence: tick.sequence, taskId: tick.taskId },
      '[Feed Listener] received tick — new task available',
    );
  };

  constructor(private readonly feedService: TaskFeedService) {
    this.feedService.on('tick', this.handleTick);
  }

  stop(): void {
    this.feedService.off('tick', this.handleTick);
  }
}
