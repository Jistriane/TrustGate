export interface ExecutorRecord {
  publicKey: string;
  metadataUri: string;
  registeredAt: string;
}

export class ExecutorRepository {
  private readonly executors = new Map<string, ExecutorRecord>();

  save(record: ExecutorRecord): void {
    this.executors.set(record.publicKey, record);
  }

  findByPublicKey(publicKey: string): ExecutorRecord | undefined {
    return this.executors.get(publicKey);
  }

  list(): ExecutorRecord[] {
    return Array.from(this.executors.values());
  }
}
