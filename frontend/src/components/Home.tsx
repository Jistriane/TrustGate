import { useCallback, useEffect, useRef, useState } from "react";
import TaskFlow from "./TaskFlow";
import { GateIcon } from "./icons";
import { getHealth } from "../api";
import type { LogEntry, LogLevel } from "../types";
import "./Home.css";

const NETWORK = import.meta.env.VITE_NETWORK || "local";
const MAX_LOG_ENTRIES = 60;

type Health = "checking" | "online" | "offline";

const HEALTH_LABEL: Record<Health, string> = {
  checking: "Checking API",
  online: "API online",
  offline: "API unreachable",
};

export default function Home() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<Health>("checking");
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    getHealth()
      .then(() => active && setHealth("online"))
      .catch(() => active && setHealth("offline"));
    return () => {
      active = false;
    };
  }, []);

  const addLog = useCallback((message: string, level: LogLevel = "info") => {
    sequence.current += 1;
    const entry: LogEntry = {
      id: sequence.current,
      time: new Date().toLocaleTimeString(),
      level,
      message,
    };
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">
            <GateIcon size={20} />
          </span>
          <div>
            <h1 className="brand__name">TrustGate</h1>
            <p className="brand__tag">Trust-minimized task marketplace on Stellar</p>
          </div>
        </div>

        <div className="topbar__meta">
          <span className="badge badge--network">{NETWORK}</span>
          <span className="badge" data-state={health}>
            <span className="badge__dot" aria-hidden="true" />
            {HEALTH_LABEL[health]}
          </span>
        </div>
      </header>

      <main>
        <TaskFlow
          log={log}
          addLog={addLog}
          clearLog={clearLog}
          loading={loading}
          setLoading={setLoading}
        />
      </main>
    </div>
  );
}
