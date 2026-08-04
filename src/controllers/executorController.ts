import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { RegistryServiceLike } from '../services/registryService';
import { ExecutorRepositoryLike } from '../repositories/executorRepository';

export class ExecutorController {
  constructor(
    private readonly registryService: RegistryServiceLike,
    private readonly executorRepository: ExecutorRepositoryLike,
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    if (process.env.NETWORK === 'local') {
      const { secret, metadataUri } = req.body ?? {};

      if (typeof secret !== 'string' || typeof metadataUri !== 'string' || !metadataUri.trim()) {
        res.status(400).json({ error: 'secret and metadataUri are required' });
        return;
      }

      let executor: Keypair;
      try {
        executor = Keypair.fromSecret(secret);
      } catch {
        res.status(400).json({ error: 'invalid secret' });
        return;
      }

      try {
        await this.registryService.registerExecutor(executor, metadataUri);
      } catch (err) {
        res.status(409).json({ error: 'registration failed', detail: (err as Error).message });
        return;
      }

      const record = {
        publicKey: executor.publicKey(),
        metadataUri,
        registeredAt: new Date().toISOString(),
      };
      await this.executorRepository.save(record);

      res.status(201).json(record);
      return;
    }

    const { publicKey, metadataUri } = req.body ?? {};
    if (typeof publicKey !== 'string' || typeof metadataUri !== 'string' || !metadataUri.trim()) {
      res.status(400).json({ error: 'publicKey and metadataUri are required' });
      return;
    }

    const registered = await this.registryService.isRegistered(publicKey);
    if (!registered) {
      res.status(409).json({ error: 'executor is not registered on-chain' });
      return;
    }

    const record = {
      publicKey,
      metadataUri,
      registeredAt: new Date().toISOString(),
    };
    await this.executorRepository.save(record);
    res.status(201).json(record);
  };
}
