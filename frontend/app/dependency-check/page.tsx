"use client";

import { useCallback, useEffect, useState } from "react";
import { useApiBase } from "../components/ApiBaseProvider";

const inlinedPublic =
  typeof process.env.NEXT_PUBLIC_API_URL === "string"
    ? process.env.NEXT_PUBLIC_API_URL.trim()
    : "";

type DependencyResponse = {
  supabase_configured: boolean;
  required_vars_present: Record<string, boolean>;
  bucket: string;
  path_prefix: string;
  storage_write_ok: boolean;
  test_public_url: string | null;
  error: string | null;
  elevenlabs_configured: boolean;
  elevenlabs_required_vars_present: Record<string, boolean>;
  elevenlabs_api_ok: boolean;
  elevenlabs_model_id: string;
  elevenlabs_model_available: boolean;
  elevenlabs_output_format: string;
  elevenlabs_error: string | null;
};

function isLocalhostApi(url: string) {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export default function DependencyCheckPage() {
  const { apiBase, ready: apiReady } = useApiBase();
  const [data, setData] = useState<DependencyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string>("");

  const load = useCallback(async () => {
    if (!apiReady) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/dependency-check`);
      if (!res.ok) throw new Error("Failed to load dependency check");
      setData(await res.json());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      if (msg === "Failed to fetch" || msg.includes("fetch")) {
        setError(
          `${msg}. On Vercel set BACKEND_URL (recommended, no rebuild needed for URL changes) or NEXT_PUBLIC_API_URL (requires redeploy). ` +
            "Ensure Render CORS_ALLOW_ORIGINS includes this site's origin."
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase, apiReady]);

  useEffect(() => {
    setOrigin(typeof window !== "undefined" ? window.location.origin : "");
  }, []);

  useEffect(() => {
    if (!apiReady) return;
    void load();
  }, [apiReady, load]);

  const apiLooksWrong =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    isLocalhostApi(apiBase);

  return (
    <main className="min-h-screen px-4 py-10 flex flex-col items-center gap-6 max-w-3xl mx-auto">
      <div className="w-full">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Dependency Check</h1>
        <p className="text-gray-400 text-sm">
          Frontend config (this deployment) and backend health (Supabase + ElevenLabs on Render).
        </p>
      </div>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">1) Frontend (this app)</h2>
        </div>
        <div className="text-sm space-y-3">
          <div className="bg-gray-800 rounded-lg p-3">
            <p className="text-gray-400 text-xs mb-1">Page origin</p>
            <p className="font-mono text-xs break-all">{origin || "(loading…)"}</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <p className="text-gray-400 text-xs mb-1">NEXT_PUBLIC_API_URL (baked in at build, may be empty)</p>
            <p className="font-mono text-xs break-all">{inlinedPublic || "(not set at build)"}</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <p className="text-gray-400 text-xs mb-1">Resolved API base (used for fetches)</p>
            <p className="font-mono text-xs break-all">{apiReady ? apiBase : "…"}</p>
          </div>
          <p className="text-gray-500 text-xs">
            Prefer Vercel env <code className="text-gray-400">BACKEND_URL=https://your-api.onrender.com</code> (server-only).
            It is read at runtime via <code className="text-gray-400">/api/config</code>, so you do not depend on{" "}
            <code className="text-gray-400">NEXT_PUBLIC_*</code> being present when <code className="text-gray-400">next build</code> runs.
          </p>
          {apiLooksWrong && (
            <p className="text-amber-400 text-sm border border-amber-700/50 rounded-lg p-3">
              You are on a public host but the resolved API still points to localhost. Set{" "}
              <code className="text-amber-200">BACKEND_URL</code> on Vercel to your Render URL, or set{" "}
              <code className="text-amber-200">NEXT_PUBLIC_API_URL</code> and redeploy.
            </p>
          )}
        </div>
      </section>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">2) Backend (Render)</h2>
          <button
            onClick={() => void load()}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm transition"
          >
            Refresh
          </button>
        </div>
        <p className="text-gray-500 text-xs -mt-2">
          Request:{" "}
          <span className="font-mono text-gray-400">
            {apiReady ? `${apiBase}/dependency-check` : "…"}
          </span>
        </p>

        {!apiReady && <p className="text-sm text-gray-400">Waiting for API base…</p>}
        {loading && apiReady && <p className="text-sm text-gray-400">Checking backend...</p>}
        {error && <p className="text-sm text-red-400">Error: {error}</p>}

        {data && !loading && (
          <div className="flex flex-col gap-4 text-sm">
            <h3 className="font-medium text-gray-200">Supabase</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-gray-400 text-xs">Configured</p>
                <p className={data.supabase_configured ? "text-green-400" : "text-red-400"}>
                  {data.supabase_configured ? "Yes" : "No"}
                </p>
              </div>
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-gray-400 text-xs">Storage Write</p>
                <p className={data.storage_write_ok ? "text-green-400" : "text-red-400"}>
                  {data.storage_write_ok ? "OK" : "Failed"}
                </p>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs mb-1">Bucket</p>
              <p>{data.bucket || "-"}</p>
            </div>

            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs mb-1">Path Prefix</p>
              <p>{data.path_prefix || "-"}</p>
            </div>

            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs mb-2">Required Env Vars</p>
              <div className="flex flex-col gap-1">
                {Object.entries(data.required_vars_present).map(([k, ok]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span>{k}</span>
                    <span className={ok ? "text-green-400" : "text-red-400"}>{ok ? "OK" : "Missing"}</span>
                  </div>
                ))}
              </div>
            </div>

            {data.test_public_url && (
              <a
                href={data.test_public_url}
                target="_blank"
                rel="noreferrer"
                className="text-purple-400 hover:text-purple-300 transition"
              >
                Open test uploaded file
              </a>
            )}

            {data.error && <p className="text-red-400">Storage error: {data.error}</p>}
          </div>
        )}
      </section>

      {data && !loading && (
        <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
          <h2 className="font-semibold text-lg">ElevenLabs (backend)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Configured</p>
              <p className={data.elevenlabs_configured ? "text-green-400" : "text-red-400"}>
                {data.elevenlabs_configured ? "Yes" : "No"}
              </p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs">API Auth Check</p>
              <p className={data.elevenlabs_api_ok ? "text-green-400" : "text-red-400"}>
                {data.elevenlabs_api_ok ? "OK" : "Failed"}
              </p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Model ID</p>
              <p>{data.elevenlabs_model_id || "-"}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Model Available</p>
              <p className={data.elevenlabs_model_available ? "text-green-400" : "text-yellow-400"}>
                {data.elevenlabs_model_available ? "Yes" : "Not Found"}
              </p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 sm:col-span-2">
              <p className="text-gray-400 text-xs">Output Format</p>
              <p>{data.elevenlabs_output_format || "-"}</p>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-3 text-sm">
            <p className="text-gray-400 text-xs mb-2">Required Env Vars</p>
            <div className="flex flex-col gap-1">
              {Object.entries(data.elevenlabs_required_vars_present).map(([k, ok]) => (
                <div key={k} className="flex items-center justify-between">
                  <span>{k}</span>
                  <span className={ok ? "text-green-400" : "text-red-400"}>{ok ? "OK" : "Missing"}</span>
                </div>
              ))}
            </div>
          </div>

          {data.elevenlabs_error && <p className="text-sm text-red-400">ElevenLabs error: {data.elevenlabs_error}</p>}
        </section>
      )}
    </main>
  );
}
