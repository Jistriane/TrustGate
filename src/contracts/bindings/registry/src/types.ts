export type DataKey =
  { tag: "Executor"; values: readonly [string] };

export interface ExecutorInfo {
  metadata_uri: string;
  updated_at_ledger: number;
  registered_at_ledger: number;
}

export interface RegistryError {
  message: string;
}

export const RegistryError = {
  1: { message: "AlreadyRegistered" },
  2: { message: "NotRegistered" },
  3: { message: "ProfileUriEmpty" },
  4: { message: "ProfileUriTooLong" },
};
