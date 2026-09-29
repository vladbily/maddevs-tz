import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "./api";

/** Load a resource, serialize refreshes, and retain data during temporary outages. */
export function useResource<T>(path: string, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolvedPath, setResolvedPath] = useState(path);
  const requestReload = useRef<(() => void) | null>(null);

  /** Refresh now or queue one refresh after the pending request. */
  const reload = useCallback(function reloadResource() {
    requestReload.current?.();
  }, []);

  /** Fetch serially and cancel only when the resource or its owner changes. */
  useEffect(
    function loadResource() {
      const controller = new AbortController();
      let timer: number | undefined;
      let running = false;
      let queued = false;
      setData(null);
      setError("");
      setLoading(true);

      /** Store current results and schedule polling after the response completes. */
      async function load() {
        if (controller.signal.aborted) return;
        if (running) {
          queued = true;
          return;
        }
        window.clearTimeout(timer);
        running = true;
        try {
          const value = await api<T>(path, { signal: controller.signal });
          if (!controller.signal.aborted) {
            setData(value);
            setError("");
          }
        } catch (failure) {
          if (!controller.signal.aborted) {
            if (
              failure instanceof ApiError &&
              failure.status > 0 &&
              failure.status < 500
            )
              setData(null);
            setError(errorMessage(failure));
          }
        } finally {
          running = false;
          if (!controller.signal.aborted) {
            setResolvedPath(path);
            setLoading(false);
            if (queued) {
              queued = false;
              void load();
            } else if (pollMs) {
              timer = window.setTimeout(load, pollMs);
            }
          }
        }
      }
      /** Request fresh data when returning to a screen that updates automatically. */
      function refreshVisible() {
        if (document.visibilityState === "visible") void load();
      }
      requestReload.current = load;
      void load();
      if (pollMs) {
        window.addEventListener("focus", refreshVisible);
        document.addEventListener("visibilitychange", refreshVisible);
      }
      /** Release timers, listeners, and the active request on navigation. */
      return function stopLoading() {
        controller.abort();
        window.clearTimeout(timer);
        window.removeEventListener("focus", refreshVisible);
        document.removeEventListener("visibilitychange", refreshVisible);
      };
    },
    [path, pollMs],
  );
  const current = resolvedPath === path;
  return {
    data: current ? data : null,
    error: current ? error : "",
    loading: !current || loading,
    reload,
  };
}

/** Recalculate time-dependent actions at the event start without a network response. */
export function useHasStarted(startsAt?: string) {
  const [now, setNow] = useState(Date.now());
  const start = startsAt ? new Date(startsAt).getTime() : Infinity;
  useEffect(
    function trackStart() {
      if (!Number.isFinite(start) || start <= now) return;
      const timer = window.setTimeout(
        /** Update the clock at the start boundary or after a long timer chunk. */
        function tick() {
          setNow(Date.now());
        },
        Math.min(Math.max(start - Date.now(), 0), 2_147_483_647),
      );
      /** Remove the timer when the schedule changes or the screen closes. */
      return function stopClock() {
        window.clearTimeout(timer);
      };
    },
    [start, now],
  );
  return start <= Math.max(now, Date.now());
}
