"use client";

import { useEffect, useRef, useState } from "react";

const API = "http://localhost:8000";

type FileEntry = {
  name: string;
  filename?: string;
  concat_filename?: string;
  video_filename?: string;
  video_public_url?: string | null;
  error?: string;
};
type Job = {
  status: "processing" | "done";
  total: number;
  done: number;
  current: string | null;
  files: FileEntry[];
  has_video: boolean;
};

export default function VoiceCloner() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [names, setNames] = useState("");
  const [skipSeconds, setSkipSeconds] = useState(3);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const file = new File([blob], "recording.webm", { type: "audio/webm" });
        setAudioFile(file);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access denied");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
  }

  function handleAudioUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
  }

  function handleVideoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
  }

  function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = text
        .split(/[\n,]/)
        .map((n) => n.replace(/^["']|["']$/g, "").trim())
        .filter(Boolean);
      setNames(parsed.join(", "));
    };
    reader.readAsText(file);
  }

  async function handleGenerate() {
    if (!audioFile || !names.trim()) return;
    setError(null);
    setIsGenerating(true);
    setJob(null);
    setJobId(null);

    const form = new FormData();
    form.append("audio", audioFile);
    form.append("names", names);
    if (videoFile) form.append("video", videoFile);
    form.append("skip_seconds", String(skipSeconds));

    try {
      const res = await fetch(`${API}/generate`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to start generation");
      }
      const { jobId: id } = await res.json();
      setJobId(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setIsGenerating(false);
    }
  }

  useEffect(() => {
    if (!jobId || job?.status === "done") {
      if (pollRef.current) clearInterval(pollRef.current);
      if (job?.status === "done") setIsGenerating(false);
      return;
    }

    pollRef.current = setInterval(async () => {
      const res = await fetch(`${API}/status/${jobId}`);
      if (!res.ok) return;
      const data: Job = await res.json();
      setJob(data);
    }, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId, job?.status]);

  const nameCount = names
    .split(/[,\n]/)
    .map((n) => n.trim())
    .filter(Boolean).length;

  return (
    <main className="min-h-screen px-4 py-12 flex flex-col items-center gap-10 max-w-3xl mx-auto">
      <div className="w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-1">Voice Cloner</h1>
        <p className="text-gray-400 text-sm">
          Record your voice, add names, optionally attach a video — get personalised clips
        </p>
      </div>

      {/* Step 1: Reference Audio */}
      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <h2 className="font-semibold text-lg">
          <span className="text-purple-400 mr-2">01</span>Reference Audio
        </h2>
        <p className="text-gray-400 text-sm">
          Record 30–60 seconds of your natural voice, or upload an existing file.
        </p>

        <div className="flex gap-3 flex-wrap">
          {!isRecording ? (
            <button
              onClick={startRecording}
              className="bg-purple-600 hover:bg-purple-500 px-5 py-2.5 rounded-lg text-sm font-medium transition"
            >
              Start Recording
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="bg-red-600 hover:bg-red-500 px-5 py-2.5 rounded-lg text-sm font-medium transition flex items-center gap-2"
            >
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              Stop ({recordSeconds}s)
            </button>
          )}

          <label className="bg-gray-700 hover:bg-gray-600 px-5 py-2.5 rounded-lg text-sm font-medium transition cursor-pointer">
            Upload File
            <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
          </label>
        </div>

        {audioUrl && (
          <div className="flex flex-col gap-1">
            <audio src={audioUrl} controls className="w-full h-10 accent-purple-500" />
            <p className="text-xs text-gray-500">
              {audioFile?.name} ({((audioFile?.size ?? 0) / 1024).toFixed(0)} KB)
            </p>
          </div>
        )}
      </section>

      {/* Step 2: Names */}
      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <h2 className="font-semibold text-lg">
          <span className="text-purple-400 mr-2">02</span>Names
        </h2>
        <p className="text-gray-400 text-sm">
          Enter names separated by commas or newlines, or upload a CSV.
        </p>

        <textarea
          value={names}
          onChange={(e) => setNames(e.target.value)}
          placeholder="Abbas, Hamza, Ahmad, Zara..."
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm outline-none focus:border-purple-500 transition resize-none"
        />

        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-400 hover:text-white cursor-pointer transition">
            Upload CSV
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCSV} />
          </label>
          {nameCount > 0 && (
            <span className="text-xs text-gray-500">{nameCount} name{nameCount !== 1 ? "s" : ""}</span>
          )}
        </div>
      </section>

      {/* Step 3: Original Video (optional) */}
      <section className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <h2 className="font-semibold text-lg">
            <span className="text-purple-400 mr-2">03</span>Original Video
            <span className="ml-2 text-xs text-gray-500 font-normal">optional</span>
          </h2>
        </div>
        <p className="text-gray-400 text-sm">
          Upload your pitch video. Each personalised clip will start with "Hey [Name]" then cut straight into it.
        </p>

        <label className="bg-gray-700 hover:bg-gray-600 px-5 py-2.5 rounded-lg text-sm font-medium transition cursor-pointer w-fit">
          {videoFile ? "Change Video" : "Upload Video"}
          <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
        </label>

        {videoUrl && (
          <div className="flex flex-col gap-1">
            <video
              src={videoUrl}
              controls
              className="w-full rounded-xl border border-gray-700 max-h-48 object-contain bg-black"
            />
            <p className="text-xs text-gray-500">
              {videoFile?.name} ({((videoFile?.size ?? 0) / 1024 / 1024).toFixed(1)} MB)
            </p>
          </div>
        )}
      </section>

      {/* Skip seconds */}
      <div className="w-full flex items-center justify-between bg-gray-900 border border-gray-800 rounded-2xl px-6 py-4">
        <div>
          <p className="text-sm font-medium">Skip first N seconds of reference audio</p>
          <p className="text-xs text-gray-500 mt-0.5">Trims the "Hey" from your original recording so it doesn't double up</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={skipSeconds}
            onChange={(e) => setSkipSeconds(Number(e.target.value))}
            className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-purple-500 text-center"
          />
          <span className="text-sm text-gray-400">sec</span>
        </div>
      </div>

      {/* Generate */}
      <div className="w-full flex flex-col gap-3">
        {error && <p className="text-red-400 text-sm">Error: {error}</p>}
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !audioFile || nameCount === 0}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed py-3.5 rounded-xl font-semibold text-base transition"
        >
          {isGenerating
            ? job
              ? `Generating… ${job.done}/${job.total}`
              : "Starting…"
            : `Generate ${nameCount > 0 ? nameCount : ""} Clip${nameCount !== 1 ? "s" : ""}${videoFile ? " + Video" : ""}`}
        </button>

        {job && job.status === "processing" && (
          <div className="flex flex-col gap-2">
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${(job.done / job.total) * 100}%` }}
              />
            </div>
            {job.current && (
              <p className="text-sm text-gray-400 text-center">
                Cloning voice for <span className="text-white font-medium">{job.current}</span>…
              </p>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      {job && job.files.length > 0 && (
        <section className="w-full flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-lg">
              {job.status === "done" ? "Done" : "Progress"} — {job.done}/{job.total}
            </h2>
            {job.status === "done" && (
              <a
                href={`${API}/download-all/${jobId}`}
                className="text-sm bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg transition"
              >
                Download All (ZIP)
              </a>
            )}
          </div>

          <div className="flex flex-col gap-4">
            {job.files.map((entry) => (
              <div
                key={entry.name}
                className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">Hey {entry.name}</span>
                  {entry.error ? (
                    <span className="text-red-400 text-xs">{entry.error}</span>
                  ) : (
                    <div className="flex gap-3 text-xs">
                      {entry.filename && (
                        <a href={`${API}/download/${entry.filename}`} download className="text-purple-400 hover:text-purple-300 transition">
                          Hey only
                        </a>
                      )}
                      {entry.concat_filename && (
                        <a href={`${API}/download/${entry.concat_filename}`} download className="text-blue-400 hover:text-blue-300 transition">
                          Full audio
                        </a>
                      )}
                      {entry.video_filename && (
                        <a
                          href={entry.video_public_url || `${API}/download/${entry.video_filename}`}
                          download
                          className="text-green-400 hover:text-green-300 transition"
                        >
                          Video
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {entry.video_filename ? (
                  <video
                    src={entry.video_public_url || `${API}/download/${entry.video_filename}`}
                    controls
                    className="w-full rounded-lg border border-gray-700 bg-black max-h-56 object-contain"
                  />
                ) : null}

                {entry.concat_filename && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-gray-500">Full clip — Hey {entry.name} + your original audio</p>
                    <audio
                      src={`${API}/download/${entry.concat_filename}`}
                      controls
                      className="w-full h-9 accent-blue-500"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
