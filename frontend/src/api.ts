import { Keypair } from "@stellar/stellar-sdk";
import type { Task, Bid, NonceResponse } from "./types";

const API = import.meta.env.VITE_API_URL || "";

const NETWORK = import.meta.env.VITE_NETWORK || "local";
const USE_SIGNING = NETWORK !== "local";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.detail || JSON.stringify(body));
  return body as T;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signedRequest<T>(
  path: string,
  init: RequestInit,
  secretKey?: string
): Promise<T> {
  if (!USE_SIGNING || !secretKey) {
    return request<T>(path, init);
  }

  const kp = Keypair.fromSecret(secretKey);
  const publicKey = kp.publicKey();

  const nonceRes = await request<NonceResponse>("/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });

  const timestamp = Date.now();
  const nonce = nonceRes.nonce;

  const bodyHash = init.body ? await sha256Hex(String(init.body)) : "";

  const payload = `${init.method || "GET"}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = kp
    .sign(new TextEncoder().encode(payload) as unknown as Parameters<typeof kp.sign>[0])
    .toString("base64");

  const headers = new Headers(init.headers);
  headers.set("x-tg-public-key", publicKey);
  headers.set("x-tg-timestamp", String(timestamp));
  headers.set("x-tg-nonce", nonce);
  headers.set("x-tg-signature", signature);

  return request<T>(path, { ...init, headers });
}

export async function getHealth() {
  return request<{ status: string }>("/health");
}

export async function getTask(taskId: string) {
  return request<Task>(`/tasks/${taskId}`);
}

export async function getHealthDetailed() {
  return request<{ status: string; dependencies: Record<string, { status: string; latencyMs: number }> }>(
    "/health/detailed"
  );
}

export async function getNonce(publicKey: string) {
  return request<NonceResponse>("/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
}

export async function registerExecutor(secret: string, metadataUri: string) {
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  };

  if (USE_SIGNING) {
    const kp = Keypair.fromSecret(secret);
    const publicKey = kp.publicKey();
    return signedRequest<{ publicKey: string; metadataUri: string; registeredAt: string }>(
      "/executors/register",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ publicKey, metadataUri }),
      },
      secret
    );
  }

  return request<{ publicKey: string; metadataUri: string; registeredAt: string }>(
    "/executors/register",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ secret, metadataUri }),
    }
  );
}

export async function createTask(
  requester: string,
  secret: string,
  reservePrice: string,
  description: string,
  deadline: string
) {
  const body = USE_SIGNING
    ? { requester, reservePrice, description, deadline }
    : { requester, secret, reservePrice, description, deadline };

  return signedRequest<Task>(
    "/tasks",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    secret
  );
}

export async function placeBid(
  taskId: string,
  executor: string,
  secret: string,
  amount: string,
  collateral: string
) {
  const body = USE_SIGNING
    ? { taskId, executor, amount, collateral }
    : { taskId, executor, secret, amount, collateral };

  return signedRequest<Bid>(
    "/bids",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    secret
  );
}

export async function selectBid(taskId: string, adminSecret: string) {
  return request<{ task: Task; winningBid: Bid }>(`/tasks/${taskId}/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": adminSecret,
      "Idempotency-Key": crypto.randomUUID(),
    },
  });
}

export async function publishResult(
  taskId: string,
  executorPublicKey: string,
  payload: unknown,
  secret?: string
) {
  return signedRequest<{ taskId: string; payloadHash: string }>(
    `/executor/tasks/${taskId}/result`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ executorPublicKey, payload }),
    },
    secret
  );
}

export async function completeTask(taskId: string, requester: string, secret: string) {
  const body = USE_SIGNING
    ? { requester }
    : { requester, secret };

  return signedRequest<{ task: Task; status?: string }>(
    `/tasks/${taskId}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    secret
  );
}

export async function getResult(taskId: string) {
  return request<{ taskId: string; payloadHash: string; payload: unknown }>(
    `/executor/tasks/${taskId}/result`
  );
}
