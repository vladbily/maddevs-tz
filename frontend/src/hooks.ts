import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";

/** Load a resource and ignore obsolete responses after navigation or refresh. */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolvedPath, setResolvedPath] = useState(path);
  const [version, setVersion] = useState(0);

  /** Trigger another request without replacing the current content with a spinner. */
  const reload = useCallback(function reloadResource() {
    /** Increment the request revision. */
    setVersion(function nextVersion(previous) {
      return previous + 1;
    });
  }, []);

  /** Fetch the current route's data and abort it when the route changes. */
  useEffect(
    function loadResource() {
      const controller = new AbortController();

      /** Store only results belonging to the active request. */
      async function load() {
        try {
          const value = await api<T>(path, { signal: controller.signal });
          if (!controller.signal.aborted) {
            setData(value);
            setError("");
          }
        } catch (failure) {
          if (!controller.signal.aborted) {
            setData(null);
            setError(errorMessage(failure));
          }
        } finally {
          if (!controller.signal.aborted) {
            setResolvedPath(path);
            setLoading(false);
          }
        }
      }
      void load();
      /** Cancel the request on unmount or a newer request. */
      return function stopLoading() {
        controller.abort();
      };
    },
    [path, version],
  );
  const current = resolvedPath === path;
  return {
    data: current ? data : null,
    error: current ? error : "",
    loading: !current || loading,
    reload,
  };
}
