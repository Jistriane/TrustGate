export interface Task {
  id: string;
  requesterPublicKey: string;
  reservePrice: string;
  reservePriceStroops: string;
  description: string;
  deadline: string;
  status: "OPEN" | "ASSIGNED" | "COMPLETING" | "COMPLETED" | "EXPIRED";
}

export interface Bid {
  id: string;
  taskId: string;
  executorPublicKey: string;
  amount: string;
  amountStroops: string;
  collateral: string;
  collateralStroops: string;
  escrowId: string;
  status: "PENDING" | "SELECTED" | "REJECTED";
  createdAt: string;
}

export type LogLevel = "info" | "success" | "error";

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

export interface NonceResponse {
  version: number;
  publicKey: string;
  timestamp: number;
  nonce: string;
  ttlSeconds: number;
}
