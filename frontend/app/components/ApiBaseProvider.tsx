"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

const defaultLocal = "http://localhost:8000";

type ApiBaseContextValue = {
  apiBase: string;
  ready: boolean;
};

const ApiBaseContext = createContext<ApiBaseContextValue>({
  apiBase: defaultLocal,
  ready: false,
});

function trimBase(url: string) {
  return url.trim().replace(/\/+$/, "");
}

export function ApiBaseProvider({ children }: { children: React.ReactNode }) {
  const inlined =
    typeof process.env.NEXT_PUBLIC_API_URL === "string"
      ? process.env.NEXT_PUBLIC_API_URL.trim()
      : "";
  const [apiBase, setApiBase] = useState(() =>
    inlined ? trimBase(inlined) : defaultLocal
  );
  const [ready, setReady] = useState(Boolean(inlined));

  useEffect(() => {
    if (inlined) {
      setApiBase(trimBase(inlined));
      setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const data = (await res.json()) as { apiBaseUrl?: string };
        const raw = (data.apiBaseUrl || defaultLocal).trim() || defaultLocal;
        if (!cancelled) {
          setApiBase(trimBase(raw));
          setReady(true);
        }
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inlined]);

  const value = useMemo(() => ({ apiBase, ready }), [apiBase, ready]);
  return <ApiBaseContext.Provider value={value}>{children}</ApiBaseContext.Provider>;
}

export function useApiBase() {
  return useContext(ApiBaseContext);
}
