/**
 * Union: DataKey
 */
 export type DataKey =
  { tag: "Executor"; values: readonly [string] };

/**
 * Struct: ExecutorInfo
 */
export interface ExecutorInfo {
  metadata_uri: string;
}

/**
 * Error Enum: RegistryError
 *
 * Declaration-merged with the `RegistryError` const below: `client.ts` uses
 * `RegistryError` as the error type argument to `Result<T, E>`, which
 * requires `E extends ErrorMessage` (`{ message: string }`) per
 * `@stellar/stellar-sdk/contract`'s `Result` type. Without this interface,
 * `RegistryError` only exists as a value (the numeric-code-to-message map),
 * and using it as a type fails to compile (TS2749: "refers to a value, but
 * is being used as a type here").
 */
export interface RegistryError {
  message: string;
}

export const RegistryError = {
  1 : { message: "AlreadyRegistered" },
  2 : { message: "NotRegistered" }
}
