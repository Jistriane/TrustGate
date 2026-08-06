import { useEffect, useRef, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import {
  registerExecutor,
  createTask,
  placeBid,
  publishResult,
  completeTask,
  getTask,
} from "../api";
import type { LogEntry, LogLevel } from "../types";
import { CheckIcon, CopyIcon } from "./icons";
import "./TaskFlow.css";

type Props = {
  log: LogEntry[];
  addLog: (message: string, level?: LogLevel) => void;
  clearLog: () => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
};

type StepStatus = "pending" | "running" | "done" | "error";
type StepId = "register" | "create" | "bid" | "assign" | "publish" | "complete";
type Role = "requester" | "executor" | "protocol";

interface Step {
  id: StepId;
  title: string;
  role: Role;
  description: string;
}

interface StepState extends Step {
  status: StepStatus;
  detail?: string;
}

/** Terms the run is executed with — shown up front so the numbers in the
 *  timeline are readable before anything happens. */
const TERMS = {
  reserve: "10",
  bid: "9",
  collateral: "10",
  listingFeeBps: "0.5%",
};

const STEPS: Step[] = [
  {
    id: "register",
    title: "Register executor",
    role: "executor",
    description:
      "The executor publishes its metadata URI and joins the on-chain executor registry, making it eligible to bid.",
  },
  {
    id: "create",
    title: "Create task",
    role: "requester",
    description: `The requester posts the job with a $${TERMS.reserve} reserve price and pays the ${TERMS.listingFeeBps} listing fee in USDC.`,
  },
  {
    id: "bid",
    title: "Bid and lock collateral",
    role: "executor",
    description: `The executor bids $${TERMS.bid} and locks $${TERMS.collateral} of collateral in escrow as a performance bond.`,
  },
  {
    id: "assign",
    title: "Automatic assignment",
    role: "protocol",
    description:
      "The first valid bid at or under the reserve price wins. No manual selection, no auction window — the task moves to ASSIGNED.",
  },
  {
    id: "publish",
    title: "Publish result",
    role: "executor",
    description:
      "The executor submits the deliverable. The payload is hashed with SHA-256 and stored so the result can be verified later.",
  },
  {
    id: "complete",
    title: "Approve and settle",
    role: "requester",
    description:
      "The requester approves the result. The settlement worker then releases payment to the executor and returns the collateral.",
  },
];

const TASK_STATES = ["OPEN", "ASSIGNED", "COMPLETING", "COMPLETED"] as const;

const ROLE_LABEL: Record<Role, string> = {
  requester: "Requester",
  executor: "Executor",
  protocol: "Protocol",
};

/** The node only shows status as colour and shape, so announce it in text. */
const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Not started.",
  running: "In progress.",
  done: "Complete.",
  error: "Failed.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const shortKey = (key: string) => `${key.slice(0, 6)}…${key.slice(-6)}`;

export default function TaskFlow({ log, addLog, clearLog, loading, setLoading }: Props) {
  const [steps, setSteps] = useState<StepState[]>(() =>
    STEPS.map((s) => ({ ...s, status: "pending" }))
  );
  const [result, setResult] = useState<{
    taskId: string;
    payloadHash: string;
    requesterPublic: string;
    executorPublic: string;
    requesterSecret: string;
    executorSecret: string;
  } | null>(null);
  const [parties, setParties] = useState<{ requester: string; executor: string } | null>(null);
  const [taskState, setTaskState] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!loading) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    const startedAt = Date.now();
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [loading]);

  const patch = (id: StepId, next: Partial<StepState>) =>
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));

  const doneCount = steps.filter((s) => s.status === "done").length;
  const hasRunning = steps.some((s) => s.status === "running");
  const hasError = steps.some((s) => s.status === "error");
  // Half-credit the in-flight step so the bar keeps moving between milestones.
  const progress = Math.round(((doneCount + (hasRunning ? 0.5 : 0)) / STEPS.length) * 100);
  const stateIndex = taskState ? TASK_STATES.indexOf(taskState as (typeof TASK_STATES)[number]) : -1;

  const start = async () => {
    setLoading(true);
    setError(null);
    setElapsedMs(0);
    setResult(null);
    setTaskState(null);
    setSteps(STEPS.map((s) => ({ ...s, status: "pending" })));
    clearLog();

    try {
      const requester = Keypair.random();
      const executor = Keypair.random();
      setParties({ requester: requester.publicKey(), executor: executor.publicKey() });

      const metadataUri = "https://executor.example.com/meta.json";
      const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
      const payload = { summary: "Document summarized successfully", pages: 12 };

      addLog(`Generated keypairs · requester ${shortKey(requester.publicKey())}`);

      patch("register", { status: "running", detail: "Signing registration…" });
      const registration = await registerExecutor(executor.secret(), metadataUri);
      patch("register", { status: "done", detail: shortKey(registration.publicKey) });
      addLog(`Executor registered: ${registration.publicKey}`, "success");
      await sleep(400);

      patch("create", {
        status: "running",
        detail: `Escrowing $${TERMS.reserve}.00 + ${TERMS.listingFeeBps} fee…`,
      });
      const task = await createTask(
        requester.publicKey(),
        requester.secret(),
        TERMS.reserve,
        "Summarize this document",
        deadline
      );
      setTaskState(task.status);
      patch("create", { status: "done", detail: `Task ${task.id.slice(0, 8)}… · ${task.status}` });
      addLog(`Task created: ${task.id}`, "success");
      await sleep(400);

      patch("bid", { status: "running", detail: `Locking $${TERMS.collateral}.00 collateral…` });
      const bid = await placeBid(
        task.id,
        executor.publicKey(),
        executor.secret(),
        TERMS.bid,
        TERMS.collateral
      );
      patch("bid", { status: "done", detail: `Bid ${bid.id.slice(0, 8)}… · $${bid.amount}` });
      addLog(`Bid placed: $${bid.amount} with $${bid.collateral} collateral`, "success");

      patch("assign", { status: "running", detail: "Matching bids against reserve…" });
      await sleep(500);
      setTaskState("ASSIGNED");
      patch("assign", { status: "done", detail: `Winner ${shortKey(executor.publicKey())}` });
      addLog(`Task assigned to ${executor.publicKey()}`, "success");
      await sleep(400);

      patch("publish", { status: "running", detail: "Hashing payload with SHA-256…" });
      const published = await publishResult(
        task.id,
        executor.publicKey(),
        payload,
        executor.secret()
      );
      patch("publish", { status: "done", detail: `sha256 ${published.payloadHash.slice(0, 20)}…` });
      addLog(`Result published · hash ${published.payloadHash}`, "success");
      await sleep(400);

      patch("complete", { status: "running", detail: "Submitting approval…" });
      const completion = await completeTask(task.id, requester.publicKey(), requester.secret());
      setTaskState(completion.status ?? "COMPLETING");
      addLog(`Approval accepted · status ${completion.status ?? "COMPLETING"}`);

      const settled = await pollUntilSettled(task.id, (seconds) =>
        patch("complete", { status: "running", detail: `Settling escrow · ${seconds}s` })
      );
      setTaskState(settled.status);
      patch("complete", { status: "done", detail: settled.status });
      addLog(`Settled · task ${task.id} is ${settled.status}`, "success");

      setResult({
        taskId: task.id,
        payloadHash: published.payloadHash,
        requesterPublic: requester.publicKey(),
        executorPublic: executor.publicKey(),
        requesterSecret: requester.secret(),
        executorSecret: executor.secret(),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setSteps((prev) => prev.map((s) => (s.status === "running" ? { ...s, status: "error" } : s)));
      addLog(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const started = loading || doneCount > 0 || hasError;

  return (
    <section className="run" aria-busy={loading}>
      <div className="panel runbar">
        <div>
          <h2 className="runbar__title">Full task lifecycle</h2>
          <p className="runbar__desc">
            Executes every stage of a TrustGate job end to end — registration, bidding, assignment,
            delivery and escrow settlement — against the live API, using keypairs generated in your
            browser.
          </p>
        </div>

        <div className="runbar__stats">
          <div className="stat">
            <span className="stat__label">Stage</span>
            <span className="stat__value">
              {doneCount}
              <span className="stat__total"> / {STEPS.length}</span>
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">Elapsed</span>
            <span className="stat__value">{started ? `${(elapsedMs / 1000).toFixed(1)}s` : "—"}</span>
          </div>
        </div>

        <button className="btn" onClick={start} disabled={loading} type="button">
          {loading ? (
            <>
              <span className="btn__spin" data-motion="essential" aria-hidden="true" />
              Running…
            </>
          ) : started ? (
            "Run again"
          ) : (
            "Start run"
          )}
        </button>

        <div
          className="runbar__track"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Lifecycle progress"
        >
          <div
            className="runbar__fill"
            style={{ width: `${progress}%` }}
            data-state={hasError ? "error" : doneCount === STEPS.length ? "done" : "running"}
          />
        </div>
      </div>

      <div className="run__body">
        <div className="panel">
          <ol className="flow">
            {steps.map((step, i) => (
              <li key={step.id} className="flow__step" data-status={step.status}>
                <div className="flow__rail">
                  <span className="flow__node" aria-hidden="true">
                    {step.status === "done" ? (
                      <CheckIcon size={17} />
                    ) : step.status === "error" ? (
                      "!"
                    ) : step.status === "running" ? (
                      <span className="flow__spin" data-motion="essential" />
                    ) : (
                      i + 1
                    )}
                  </span>
                </div>

                <div className="flow__body">
                  <div className="flow__head">
                    <h3 className="flow__title">
                      {step.title}
                      <span className="sr-only"> — {STATUS_LABEL[step.status]}</span>
                    </h3>
                    <span className="role" data-role={step.role}>
                      {ROLE_LABEL[step.role]}
                    </span>
                  </div>
                  <p className="flow__desc">{step.description}</p>
                  {step.detail && (
                    <div className="flow__detail">
                      {step.status === "error" ? "Failed at this stage" : step.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <aside className="run__side">
          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">Task state</h3>
            </div>
            <ol className="states">
              {TASK_STATES.map((state, i) => (
                <li
                  key={state}
                  className="state"
                  data-reached={stateIndex >= 0 && i < stateIndex}
                  data-current={i === stateIndex}
                >
                  <span className="state__dot" aria-hidden="true" />
                  {state}
                </li>
              ))}
            </ol>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">Parties and terms</h3>
            </div>
            <dl className="kv">
              <div className="kv__row">
                <dt className="kv__key">Requester</dt>
                <dd className="kv__val" data-empty={!parties}>
                  {parties ? shortKey(parties.requester) : "Not generated yet"}
                </dd>
                {parties && <CopyButton value={parties.requester} label="requester address" />}
              </div>
              <div className="kv__row">
                <dt className="kv__key">Executor</dt>
                <dd className="kv__val" data-empty={!parties}>
                  {parties ? shortKey(parties.executor) : "Not generated yet"}
                </dd>
                {parties && <CopyButton value={parties.executor} label="executor address" />}
              </div>

              <div className="kv__sep" />

              <div className="kv__row">
                <dt className="kv__key">Reserve</dt>
                <dd className="kv__val">${TERMS.reserve}.00 USDC</dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">Bid</dt>
                <dd className="kv__val">${TERMS.bid}.00 USDC</dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">Collateral</dt>
                <dd className="kv__val">${TERMS.collateral}.00 USDC</dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">Listing fee</dt>
                <dd className="kv__val">{TERMS.listingFeeBps}</dd>
              </div>
            </dl>
          </div>

          <div className="panel log">
            <div className="panel__head">
              <h3 className="panel__title">Activity</h3>
              {log.length > 0 && <span className="panel__count">{log.length} events</span>}
            </div>
            {log.length === 0 ? (
              <p className="log__empty">
                Nothing yet. Start a run and every API call will stream here as it happens.
              </p>
            ) : (
              <ul className="log__list" aria-live="polite" aria-label="Activity log">
                {log.map((entry) => (
                  <li key={entry.id} className="log__entry" data-level={entry.level}>
                    <span className="log__dot" aria-hidden="true" />
                    <span className="log__time">{entry.time}</span>
                    <span className="log__msg">{entry.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {error && (
        <div className="alert" role="alert">
          <span className="alert__title">The run stopped early</span>
          <span className="alert__body">{error}</span>
        </div>
      )}

      {result && (
        <div className="panel result">
          <div className="result__head">
            <span className="result__check" aria-hidden="true">
              <CheckIcon size={16} />
            </span>
            <h3 className="result__title">Lifecycle complete — task settled</h3>
          </div>

          <dl className="kv">
            <div className="kv__row">
              <dt className="kv__key">Task ID</dt>
              <dd className="kv__val">{result.taskId}</dd>
              <CopyButton value={result.taskId} label="task ID" />
            </div>
            <div className="kv__row">
              <dt className="kv__key">Payload hash</dt>
              <dd className="kv__val">{result.payloadHash}</dd>
              <CopyButton value={result.payloadHash} label="payload hash" />
            </div>
            <div className="kv__row">
              <dt className="kv__key">Requester</dt>
              <dd className="kv__val">{result.requesterPublic}</dd>
              <CopyButton value={result.requesterPublic} label="requester address" />
            </div>
            <div className="kv__row">
              <dt className="kv__key">Requester key</dt>
              <dd className="kv__val">{result.requesterSecret}</dd>
              <CopyButton value={result.requesterSecret} label="requester secret key" />
            </div>
            <div className="kv__row">
              <dt className="kv__key">Executor</dt>
              <dd className="kv__val">{result.executorPublic}</dd>
              <CopyButton value={result.executorPublic} label="executor address" />
            </div>
            <div className="kv__row">
              <dt className="kv__key">Executor key</dt>
              <dd className="kv__val">{result.executorSecret}</dd>
              <CopyButton value={result.executorSecret} label="executor secret key" />
            </div>
          </dl>

          <p className="result__note">
            These keypairs were generated in your browser for this run only. They hold no real
            balance — never fund them or reuse them anywhere else.
          </p>
        </div>
      )}
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (insecure origin or denied permission) — the value
      // stays selectable on screen, so there is nothing to recover from.
    }
  };

  return (
    <button
      type="button"
      className="iconbtn"
      data-copied={copied}
      onClick={copy}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  );
}

async function pollUntilSettled(
  taskId: string,
  onTick: (seconds: number) => void,
  timeoutMs = 90000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = await getTask(taskId);
    if (task.status === "COMPLETED" || task.status === "EXPIRED") return task;
    onTick(Math.round((Date.now() - startedAt) / 1000));
    await sleep(2000);
  }
  return getTask(taskId);
}
