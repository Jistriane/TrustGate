import 'dotenv/config';
import { createApp } from './app';
import { loadStellarConfig } from './config/stellar';
import { generateKeypair, loadKeypairFromEnv } from './utils/keypair';
import { AccountService } from './services/accountService';
import { TaskFeedService } from './services/taskFeedService';
import { FeedListenerService } from './services/feedListenerService';
import { TimeoutService } from './services/timeoutService';

async function fundOnFriendbot(horizonUrl: string, publicKey: string): Promise<void> {
  const res = await fetch(`${horizonUrl}/friendbot?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
  }
}

async function checkStellarConnectivity(): Promise<void> {
  const config = loadStellarConfig();
  console.log(`Connecting to Stellar (${config.network}) via ${config.horizonUrl}`);

  const admin = process.env.ADMIN_SECRET
    ? loadKeypairFromEnv('ADMIN_SECRET')
    : generateKeypair();

  if (!process.env.ADMIN_SECRET && config.network === 'local') {
    console.log(`No ADMIN_SECRET set, funding throwaway admin ${admin.publicKey()} via friendbot`);
    await fundOnFriendbot(config.horizonUrl, admin.publicKey());
  }

  const accountService = new AccountService(config);
  const xlmBalance = await accountService.getXlmBalance(admin.publicKey());

  console.log(`Admin account: ${admin.publicKey()}`);
  console.log(`XLM balance: ${xlmBalance}`);
}

async function main(): Promise<void> {
  await checkStellarConnectivity();

  const port = Number(process.env.PORT) || 3000;
  const app = createApp();

  const taskFeedService = app.get('taskFeedService') as TaskFeedService;
  new FeedListenerService(taskFeedService);

  const timeoutService = app.get('timeoutService') as TimeoutService;
  timeoutService.schedule();

  app.listen(port, () => {
    console.log(`TrustGate server listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
