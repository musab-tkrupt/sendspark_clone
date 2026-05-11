"use client";

import { useState } from "react";
import { useApiBase } from "../components/ApiBaseProvider";

export default function ElevenLabsTestPage() {
  const { apiBase, ready: apiReady } = useApiBase();
  const [voiceId, setVoiceId] = useState("");
  const [ttsText, setTtsText] = useState("Hello from ElevenLabs test endpoint.");
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [modelsResult, setModelsResult] = useState<string>("");
  const [ttsResult, setTtsResult] = useState<string>("");
  const [cloneResult, setCloneResult] = useState<string>("");
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  async function testModels() {
    if (!apiReady) return;
    setLoadingKey("models");
    setModelsResult("");
    try {
      const res = await fetch(`${apiBase}/elevenlabs/models`);
      const data = await res.json();
      setModelsResult(JSON.stringify(data, null, 2));
    } catch (e: unknown) {
      setModelsResult(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoadingKey(null);
    }
  }

  async function testTts() {
    if (!apiReady) return;
    setLoadingKey("tts");
    setTtsResult("");
    try {
      const form = new FormData();
      form.append("voice_id", voiceId);
      form.append("text", ttsText);
      const res = await fetch(`${apiBase}/elevenlabs/test-tts`, { method: "POST", body: form });
      const data = await res.json();
      setTtsResult(JSON.stringify(data, null, 2));
    } catch (e: unknown) {
      setTtsResult(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoadingKey(null);
    }
  }

  async function testClone() {
    if (!apiReady || !sampleFile) return;
    setLoadingKey("clone");
    setCloneResult("");
    try {
      const form = new FormData();
      form.append("sample_audio", sampleFile);
      form.append("name", `cursor-test-${Date.now()}`);
      form.append("delete_after_test", "true");
      const res = await fetch(`${apiBase}/elevenlabs/test-clone`, { method: "POST", body: form });
      const data = await res.json();
      setCloneResult(JSON.stringify(data, null, 2));
    } catch (e: unknown) {
      setCloneResult(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <main className="min-h-screen px-4 py-10 flex flex-col items-center gap-6 max-w-4xl mx-auto">
      <div className="w-full">
        <h1 className="text-3xl font-bold tracking-tight mb-1">ElevenLabs API Test</h1>
        <p className="text-gray-400 text-sm">Simple test page for models, test TTS, and instant clone.</p>
        {!apiReady && <p className="text-amber-400 text-sm">Loading API base…</p>}
      </div>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-3">
        <h2 className="text-lg font-semibold">1) Models API</h2>
        <button
          onClick={testModels}
          disabled={!apiReady || loadingKey !== null}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-4 py-2 rounded-lg text-sm w-fit"
        >
          {loadingKey === "models" ? "Checking..." : "Fetch Models"}
        </button>
        {modelsResult && (
          <pre className="text-xs bg-gray-800 border border-gray-700 rounded-lg p-3 overflow-auto max-h-56">{modelsResult}</pre>
        )}
      </section>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-3">
        <h2 className="text-lg font-semibold">2) TTS API (voice_id required)</h2>
        <input
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder="Enter ElevenLabs voice_id"
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-purple-500"
        />
        <textarea
          value={ttsText}
          onChange={(e) => setTtsText(e.target.value)}
          rows={3}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-purple-500"
        />
        <button
          onClick={testTts}
          disabled={!apiReady || !voiceId.trim() || loadingKey !== null}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-4 py-2 rounded-lg text-sm w-fit"
        >
          {loadingKey === "tts" ? "Generating..." : "Run TTS Test"}
        </button>
        {ttsResult && (
          <pre className="text-xs bg-gray-800 border border-gray-700 rounded-lg p-3 overflow-auto max-h-56">{ttsResult}</pre>
        )}
      </section>

      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-3">
        <h2 className="text-lg font-semibold">3) Clone API test (sample upload)</h2>
        <input
          type="file"
          accept="audio/*,video/webm"
          onChange={(e) => setSampleFile(e.target.files?.[0] || null)}
          className="text-sm"
        />
        <button
          onClick={testClone}
          disabled={!apiReady || !sampleFile || loadingKey !== null}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-4 py-2 rounded-lg text-sm w-fit"
        >
          {loadingKey === "clone" ? "Testing..." : "Run Clone Test"}
        </button>
        {cloneResult && (
          <pre className="text-xs bg-gray-800 border border-gray-700 rounded-lg p-3 overflow-auto max-h-56">{cloneResult}</pre>
        )}
      </section>
    </main>
  );
}
