"use client";

import { useEffect, useState } from "react";

const API = "http://localhost:8000";

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

export default function DependencyCheckPage() {
  const [data, setData] = useState<DependencyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/dependency-check`);
      if (!res.ok) throw new Error("Failed to load dependency check");
      setData(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="min-h-screen px-4 py-10 flex flex-col items-center gap-6 max-w-3xl mx-auto">
      <div className="w-full">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Dependency Check</h1>
        <p className="text-gray-400 text-sm">Supabase and ElevenLabs health from backend.</p>
      </div>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">Supabase</h2>
          <button
            onClick={() => void load()}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm transition"
          >
            Refresh
          </button>
        </div>

        {loading && <p className="text-sm text-gray-400">Checking dependencies...</p>}
        {error && <p className="text-sm text-red-400">Error: {error}</p>}

        {data && !loading && (
          <div className="flex flex-col gap-4 text-sm">
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
          <h2 className="font-semibold text-lg">ElevenLabs</h2>
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
