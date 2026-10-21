import { useCallback, useEffect, useRef, useState } from "react";

export function useHashRoute() {
  const read = () => {
    const parts = (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
    return { page: parts[0] || "overview", params: parts.slice(1) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((path: string, options: { replace?: boolean } = {}) => {
    const hash = `#/${path.split("/").map(encodeURIComponent).join("/")}`;
    if (options.replace) {
      history.replaceState(null, "", hash);
      setRoute(read());
    } else {
      location.hash = hash;
    }
  }, []);
  return { ...route, navigate };
}

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fn` when `deps` change (and every `pollMs` while the tab is visible).
 * Keeps the last data while reloading or after an error, and ignores
 * responses that arrive after a newer request started.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], options: { pollMs?: number; enabled?: boolean } = {}): AsyncState<T> {
  const { pollMs, enabled = true } = options;
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: enabled });
  const request = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(() => {
    const id = ++request.current;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (data) => id === request.current && setState({ data, loading: false }),
      (error: Error) => id === request.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, []);

  // New deps start from scratch instead of showing the previous result.
  useEffect(() => {
    if (!enabled) return;
    request.current++;
    setState({ loading: true });
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const timer = setInterval(() => document.visibilityState === "visible" && run(), pollMs);
    const onVisible = () => document.visibilityState === "visible" && run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run, pollMs, enabled]);

  return { data: state.data, error: state.error, loading: state.loading, reload: run };
}

export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    },
    [key],
  );
  return [value, set];
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
