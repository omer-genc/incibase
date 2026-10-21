import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { admin, health, type AppInfo } from "./api";

interface ServerState {
  online: boolean;
  version?: string;
  startedAt?: number;
  app?: AppInfo;
  appError?: Error;
  reloadApp: () => Promise<void>;
}

const ServerContext = createContext<ServerState | null>(null);

/**
 * Watches `/api/health`. When the server restarts (dev hot reload) the schema
 * and function list are fetched again so every page shows the current app.
 */
export function ServerProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [info, setInfo] = useState<{ version?: string; startedAt?: number }>({});
  const [app, setApp] = useState<AppInfo>();
  const [appError, setAppError] = useState<Error>();
  const startedAt = useRef<number | undefined>(undefined);

  const reloadApp = useCallback(async () => {
    try {
      setApp(await admin<AppInfo>("admin_schema"));
      setAppError(undefined);
    } catch (err) {
      setAppError(err as Error);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let wasOffline = false;
    const check = async () => {
      try {
        const h = await health();
        if (stopped) return;
        setOnline(true);
        setInfo({ version: h.version, startedAt: h.startedAt });
        if (startedAt.current !== undefined && startedAt.current !== h.startedAt) {
          await reloadApp();
          toast.success("Server restarted", { description: "Schema and functions reloaded." });
        } else if (wasOffline) {
          await reloadApp();
        }
        startedAt.current = h.startedAt;
        wasOffline = false;
      } catch {
        if (stopped) return;
        setOnline(false);
        wasOffline = true;
      }
    };
    void check();
    void reloadApp();
    const timer = setInterval(() => document.visibilityState === "visible" && void check(), 2500);
    // Polling pauses in background tabs; catch up as soon as the tab is visible again.
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reloadApp]);

  return (
    <ServerContext.Provider value={{ online, ...info, app, appError, reloadApp }}>{children}</ServerContext.Provider>
  );
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer outside ServerProvider");
  return ctx;
}
