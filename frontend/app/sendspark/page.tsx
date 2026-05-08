"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const API = "http://localhost:8000";
const FALLBACK_URL = "https://tkrupt.com";
const SCROLL_BATCH_SIZE = 5;

type ScrollStatus = "idle" | "queued" | "generating" | "done" | "error";
type Contact = {
  id: string;
  name: string;
  website: string;
  scrollJobId?: string;
  scrollStatus: ScrollStatus;
  scrollFilename?: string;
  isFallback?: boolean;
};
type CompositeFile = {
  name: string;
  filename?: string;
  public_url?: string;
  preview_url?: string | null;
  video_public_url?: string | null;
  thumbnail_public_url?: string | null;
  preview_id?: string | null;
  lead_slug?: string | null;
  error?: string;
};
type CompositeJob = {
  status: "processing" | "done";
  total: number;
  done: number;
  current: string | null;
  files: CompositeFile[];
};
type Step = "contacts" | "scroll" | "record" | "results";
type RecordMode = "face" | "screen";

function uid() {
  return String(Date.now() + Math.random());
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => v.replace(/^["']|["']$/g, "").trim());
}

export default function SendSpark() {
  const router = useRouter();
  const pathname = usePathname();
  const isElevenLabsMode = pathname === "/sendspark-elevenlabs";
  const currentBaseRoute = isElevenLabsMode ? "/sendspark-elevenlabs" : "/sendspark";
  const compositeStartEndpoint = isElevenLabsMode ? `${API}/composite-elevenlabs` : `${API}/composite`;
  // ── State ─────────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>("contacts");
  const [contacts, setContacts] = useState<Contact[]>([
    { id: uid(), name: "", website: "", scrollStatus: "idle" },
  ]);

  // Voice reference (optional, for cloning)
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceSec, setVoiceSec] = useState(0);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Recording
  const [recordMode, setRecordMode] = useState<RecordMode>("face");
  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [skipSeconds, setSkipSeconds] = useState(3);
  const [scrollStartSeconds, setScrollStartSeconds] = useState(0);
  const [screenScale, setScreenScale] = useState(0.85);

  // Composite
  const [compositeJobId, setCompositeJobId] = useState<string | null>(null);
  const [compositeJob, setCompositeJob] = useState<CompositeJob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const faceVideoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number>(0);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const contactsRef = useRef(contacts);
  const scrollBatchLaunchingRef = useRef(false);
  contactsRef.current = contacts;

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("step") as Step | null;
    if (fromQuery && ["contacts", "scroll", "record", "results"].includes(fromQuery)) {
      setStep(fromQuery);
    }
  }, []);

  function goToStep(next: Step) {
    setStep(next);
    router.replace(`${currentBaseRoute}?step=${next}`);
  }

  // ── Contacts helpers ──────────────────────────────────────────────────────
  function addRow() {
    setContacts((p) => [...p, { id: uid(), name: "", website: "", scrollStatus: "idle" }]);
  }

  function removeRow(id: string) {
    setContacts((p) => p.filter((c) => c.id !== id));
  }

  function updateField(id: string, field: "name" | "website", val: string) {
    setContacts((p) => p.map((c) => (c.id === id ? { ...c, [field]: val } : c)));
  }

  function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = text
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter(Boolean);
      if (!rows.length) return;

      const header = parseCsvRow(rows[0]).map((h) => h.toLowerCase().trim());
      const findHeaderIndex = (candidates: string[]) =>
        header.findIndex((h) => candidates.some((c) => h === c || h.includes(c)));

      const fullNameIdx = findHeaderIndex(["full name"]);
      const firstNameIdx = findHeaderIndex(["first name"]);
      const lastNameIdx = findHeaderIndex(["last name"]);

      // Strongly prioritize company site columns; avoid person linkedin/url columns.
      const companyWebsiteIdx = findHeaderIndex(["company website"]);
      const companyDomainIdx = findHeaderIndex(["company domain"]);
      const websiteIdx = findHeaderIndex(["website"]);
      const domainIdx = findHeaderIndex(["domain"]);

      const parsed: Contact[] = [];
      for (let i = 1; i < rows.length; i++) {
        const cols = parseCsvRow(rows[i]);
        const fullName = fullNameIdx >= 0 ? cols[fullNameIdx] || "" : "";
        const first = firstNameIdx >= 0 ? cols[firstNameIdx] || "" : "";
        const last = lastNameIdx >= 0 ? cols[lastNameIdx] || "" : "";
        const name = fullName || `${first} ${last}`.trim() || cols[0] || "";
        const websiteCandidates = [
          companyWebsiteIdx >= 0 ? cols[companyWebsiteIdx] || "" : "",
          companyDomainIdx >= 0 ? cols[companyDomainIdx] || "" : "",
          websiteIdx >= 0 ? cols[websiteIdx] || "" : "",
          domainIdx >= 0 ? cols[domainIdx] || "" : "",
          cols[1] || "",
        ]
          .map((v) => v.trim())
          .filter(Boolean);

        let website = websiteCandidates[0] || "";
        if (website && !website.startsWith("http")) {
          website = `https://${website.replace(/^www\./i, "")}`;
        }
        if (website.toLowerCase().includes("linkedin.com")) {
          continue;
        }
        if (!name || !website) continue;
        parsed.push({ id: uid(), name, website, scrollStatus: "idle" });
      }
      if (parsed.length) setContacts(parsed);
    };
    reader.readAsText(file);
  }

  const validContacts = contacts.filter((c) => c.name.trim() && c.website.trim());

  // ── Voice reference recording ─────────────────────────────────────────────
  async function startVoiceRecord() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => voiceChunksRef.current.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(voiceChunksRef.current, { type: "audio/webm" });
      const f = new File([blob], "voice-ref.webm", { type: "audio/webm" });
      setVoiceFile(f);
      setVoiceUrl(URL.createObjectURL(blob));
      stream.getTracks().forEach((t) => t.stop());
      setVoiceRecording(false);
      if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
    };
    mr.start();
    voiceRecorderRef.current = mr;
    setVoiceRecording(true);
    setVoiceSec(0);
    voiceTimerRef.current = setInterval(() => setVoiceSec((s) => s + 1), 1000);
  }

  function stopVoiceRecord() {
    voiceRecorderRef.current?.stop();
  }

  // ── Step 2: scroll generation ─────────────────────────────────────────────
  async function launchScrollBatch(batch: Contact[]) {
    if (scrollBatchLaunchingRef.current || !batch.length) return;
    scrollBatchLaunchingRef.current = true;
    try {
      const updated = await Promise.all(
        batch.map(async (c) => {
          let url = c.website.trim();
          if (!url.startsWith("http")) url = "https://" + url;
          try {
            const res = await fetch(`${API}/scroll`, {
              method: "POST",
              body: new URLSearchParams({ url }),
            });
            if (!res.ok) throw new Error();
            const { jobId } = await res.json();
            return {
              id: c.id,
              patch: { scrollJobId: jobId, scrollStatus: "queued" as ScrollStatus },
            };
          } catch {
            return { id: c.id, patch: { scrollStatus: "error" as ScrollStatus } };
          }
        })
      );

      const updates = new Map(updated.map((u) => [u.id, u.patch]));
      setContacts((prev) => prev.map((c) => ({ ...c, ...(updates.get(c.id) || {}) })));
    } finally {
      scrollBatchLaunchingRef.current = false;
    }
  }

  async function startScrollGeneration() {
    goToStep("scroll");
    const resetContacts = contacts.map((c) =>
      c.name.trim() && c.website.trim()
        ? {
            ...c,
            scrollJobId: undefined,
            scrollFilename: undefined,
            scrollStatus: "idle" as ScrollStatus,
            isFallback: false,
          }
        : c
    );
    setContacts(resetContacts);
    await launchScrollBatch(
      resetContacts.filter((c) => c.name.trim() && c.website.trim()).slice(0, SCROLL_BATCH_SIZE)
    );
  }

  // Poll scroll jobs
  useEffect(() => {
    if (step !== "scroll") return;
    const interval = setInterval(async () => {
      const pending = contactsRef.current.filter(
        (c) => (c.scrollStatus === "queued" || c.scrollStatus === "generating") && c.scrollJobId
      );
      if (!pending.length) {
        const nextBatch = contactsRef.current
          .filter((c) => c.name.trim() && c.website.trim() && c.scrollStatus === "idle")
          .slice(0, SCROLL_BATCH_SIZE);
        if (nextBatch.length) void launchScrollBatch(nextBatch);
        return;
      }

      const updates: Record<string, Partial<Contact>> = {};
      await Promise.all(
        pending.map(async (c) => {
          const res = await fetch(`${API}/scroll-status/${c.scrollJobId}`);
          if (!res.ok) return;
          const data = await res.json();
          if (data.status === "queued") {
            updates[c.id] = { scrollStatus: "queued" };
          } else if (data.status === "recording") {
            updates[c.id] = { scrollStatus: "generating" };
          } else if (data.status === "done") {
            updates[c.id] = { scrollStatus: "done", scrollFilename: data.filename };
          } else if (data.status === "error") {
            if (!c.isFallback) {
              try {
                const r2 = await fetch(`${API}/scroll`, {
                  method: "POST",
                  body: new URLSearchParams({ url: FALLBACK_URL }),
                });
                if (r2.ok) {
                  const { jobId } = await r2.json();
                  updates[c.id] = {
                    scrollJobId: jobId,
                    scrollStatus: "generating",
                    isFallback: true,
                    website: c.website + " (↓ fallback)",
                  };
                }
              } catch {
                updates[c.id] = { scrollStatus: "error" };
              }
            } else {
              updates[c.id] = { scrollStatus: "error" };
            }
          }
        })
      );

      if (Object.keys(updates).length) {
        setContacts((prev) => prev.map((c) => ({ ...c, ...(updates[c.id] || {}) })));
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [step]);

  const allScrollDone = contacts.every(
    (c) => !c.name.trim() || c.scrollStatus === "done" || c.scrollStatus === "error"
  );

  // ── Step 3: recording ─────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== "record") return;
    let active = true;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then((stream) => {
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        previewStreamRef.current = stream;
        if (faceVideoRef.current) faceVideoRef.current.srcObject = stream;
      })
      .catch(console.error);
    return () => {
      active = false;
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    };
  }, [step]);

  async function startRecording() {
    try {
      setError(null);
      chunksRef.current = [];
      setRecordSec(0);
      // Prevent stale clip reuse when user records again.
      setRecordedBlob(null);
      setRecordedUrl(null);

      if (recordMode === "face") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamsRef.current = [stream];
        if (faceVideoRef.current) faceVideoRef.current.srcObject = stream;

        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          setRecordedBlob(blob);
          setRecordedUrl(URL.createObjectURL(blob));
          stream.getTracks().forEach((t) => t.stop());
          setIsRecording(false);
          if (timerRef.current) clearInterval(timerRef.current);
        };
        mr.start(100);
        mediaRecorderRef.current = mr;
      } else {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 } as MediaTrackConstraints,
        });
        const faceStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamsRef.current = [screenStream, faceStream];

      const track = screenStream.getVideoTracks()[0].getSettings();
      const W = track.width || 1280;
      const H = track.height || 720;

      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      const sv = document.createElement("video");
      sv.srcObject = screenStream;
      sv.muted = true;
      await sv.play();

      const fv = document.createElement("video");
      fv.srcObject = faceStream;
      fv.muted = true;
      await fv.play();

      if (faceVideoRef.current) faceVideoRef.current.srcObject = faceStream;

      const bSize = Math.round(H * 0.22);
      const margin = 20;
      const bX = margin;
      const bY = H - bSize - margin;

      function draw() {
        // Draw the captured screen slightly inset to feel less zoomed in.
        const scale = Math.max(0.7, Math.min(1, screenScale));
        const srcW = sv.videoWidth || W;
        const srcH = sv.videoHeight || H;
        const fit = Math.min(W / srcW, H / srcH);
        const drawW = srcW * fit * scale;
        const drawH = srcH * fit * scale;
        const drawX = (W - drawW) / 2;
        const drawY = (H - drawH) / 2;
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(sv, drawX, drawY, drawW, drawH);
        ctx.save();
        ctx.beginPath();
        ctx.arc(bX + bSize / 2, bY + bSize / 2, bSize / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(fv, bX, bY, bSize, bSize);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(bX + bSize / 2, bY + bSize / 2, bSize / 2, 0, Math.PI * 2);
        ctx.stroke();
        animFrameRef.current = requestAnimationFrame(draw);
      }
      draw();

      const canvasStream = canvas.captureStream(30);
      faceStream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));

      const mime = "video/webm;codecs=vp8,opus";
      const mr = MediaRecorder.isTypeSupported(mime)
        ? new MediaRecorder(canvasStream, { mimeType: mime })
        : new MediaRecorder(canvasStream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        cancelAnimationFrame(animFrameRef.current);
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        setIsRecording(false);
        if (timerRef.current) clearInterval(timerRef.current);
      };
      mr.start(100);
      mediaRecorderRef.current = mr;
        screenStream.getVideoTracks()[0].onended = () => {
          if (mediaRecorderRef.current?.state === "recording") {
            mediaRecorderRef.current.stop();
          }
        };
      }

      setIsRecording(true);
      timerRef.current = setInterval(() => setRecordSec((s) => s + 1), 1000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Screen recording failed");
      setIsRecording(false);
      streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      streamsRef.current = [];
      if (timerRef.current) clearInterval(timerRef.current);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  function handleRecordedVideoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const url = URL.createObjectURL(file);
    setRecordedUrl(url);
    setRecordedBlob(file);
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  // ── Step 4: composite ─────────────────────────────────────────────────────
  async function processVideos() {
    if (!recordedBlob) return;
    setIsProcessing(true);
    setError(null);
    // Clear previous run immediately so user sees fresh generation state.
    setCompositeJob(null);
    setCompositeJobId(null);
    goToStep("results");

    const form = new FormData();
    form.append("face", recordedBlob, "face.webm");
    if (voiceFile) form.append("ref_audio", voiceFile, voiceFile.name);
    form.append("skip_seconds", String(skipSeconds));
    form.append("scroll_start_seconds", String(scrollStartSeconds));

    const contactsWithScroll = contacts.filter((c) => c.scrollFilename);
    form.append(
      "contacts",
      JSON.stringify(contactsWithScroll.map((c) => ({ name: c.name, scroll_filename: c.scrollFilename })))
    );

    try {
      const res = await fetch(compositeStartEndpoint, { method: "POST", body: form });
      if (!res.ok) throw new Error("Failed to start processing");
      const { jobId } = await res.json();
      setCompositeJobId(jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setIsProcessing(false);
    }
  }

  function downloadResultsCsv() {
    if (!compositeJob?.files?.length) return;
    const contactByName = new Map(
      contacts.map((c) => [c.name.trim().toLowerCase(), c.website.trim()])
    );

    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const header = "Name,Website URL,Video URL";
    const rows = compositeJob.files
      .filter(
        (entry) =>
          !entry.error && (entry.preview_url || entry.public_url || entry.video_public_url || entry.filename)
      )
      .map((entry) => {
        const website = contactByName.get(entry.name.trim().toLowerCase()) || "";
        const videoUrl =
          entry.preview_url ||
          entry.public_url ||
          entry.video_public_url ||
          `${API}/download/${entry.filename}`;
        return [entry.name, website, videoUrl].map((v) => escapeCsv(v || "")).join(",");
      });

    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-links-${compositeJobId || "results"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Poll composite
  useEffect(() => {
    if (!compositeJobId || compositeJob?.status === "done") {
      if (compositeJob?.status === "done") setIsProcessing(false);
      return;
    }
    const interval = setInterval(async () => {
      const res = await fetch(`${API}/composite-status/${compositeJobId}`);
      if (!res.ok) return;
      setCompositeJob(await res.json());
    }, 1500);
    return () => clearInterval(interval);
  }, [compositeJobId, compositeJob?.status]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ── Step indicator ────────────────────────────────────────────────────────
  const steps: { key: Step; label: string }[] = [
    { key: "contacts", label: "Contacts" },
    { key: "scroll", label: "Scroll Videos" },
    { key: "record", label: "Record" },
    { key: "results", label: "Results" },
  ];
  const stepIdx = steps.findIndex((s) => s.key === step);

  return (
    <main className="min-h-screen px-4 py-10 flex flex-col items-center gap-8 max-w-4xl mx-auto">

      {/* Header */}
      <div className="w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-1">SendSpark Clone</h1>
        <p className="text-gray-400 text-sm">
          {isElevenLabsMode
            ? "Personalised video outreach — ElevenLabs cloned greeting + website scroll background"
            : "Personalised video outreach — website scroll background + cloned voice greeting"}
        </p>
      </div>

      {/* Step indicator */}
      <div className="w-full flex items-center gap-0">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center flex-1">
            <div className={`flex items-center gap-2 ${i <= stepIdx ? "text-white" : "text-gray-600"}`}>
              <div className={`w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold ${
                i < stepIdx ? "bg-purple-500" : i === stepIdx ? "bg-purple-600 ring-2 ring-purple-400" : "bg-gray-800"
              }`}>
                {i < stepIdx ? "✓" : i + 1}
              </div>
              <button
                onClick={() => goToStep(s.key)}
                className="text-sm font-medium hover:text-purple-300 transition"
              >
                {s.label}
              </button>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px mx-3 ${i < stepIdx ? "bg-purple-500" : "bg-gray-800"}`} />
            )}
          </div>
        ))}
      </div>

      {/* ── STEP 1: Contacts ─────────────────────────────────────────────── */}
      {step === "contacts" && (
        <div className="w-full flex flex-col gap-6">

          {/* Voice reference */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
            <div>
              <h2 className="font-semibold text-lg">Voice Reference <span className="text-xs text-gray-500 font-normal ml-2">optional — enables cloned greeting per person</span></h2>
              <p className="text-gray-400 text-sm mt-1">Record 30–60s of your natural voice. The AI will clone it to say "Hey [Name]" for each contact.</p>
            </div>
            <div className="flex gap-3 flex-wrap">
              {!voiceRecording ? (
                <button onClick={startVoiceRecord} className="bg-purple-600 hover:bg-purple-500 px-5 py-2.5 rounded-lg text-sm font-medium transition">
                  Start Recording
                </button>
              ) : (
                <button onClick={stopVoiceRecord} className="bg-red-600 hover:bg-red-500 px-5 py-2.5 rounded-lg text-sm font-medium transition flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  Stop ({voiceSec}s)
                </button>
              )}
              <label className="bg-gray-700 hover:bg-gray-600 px-5 py-2.5 rounded-lg text-sm font-medium transition cursor-pointer">
                Upload File
                <input type="file" accept="audio/*" className="hidden" onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setVoiceFile(f); setVoiceUrl(URL.createObjectURL(f)); }
                }} />
              </label>
            </div>
            {voiceUrl && (
              <audio src={voiceUrl} controls className="w-full h-10 accent-purple-500" />
            )}
          </section>

          {/* Contacts table */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg">Contacts</h2>
              <label className="text-sm text-gray-400 hover:text-white cursor-pointer transition">
                Upload CSV
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCSV} />
              </label>
            </div>
            <p className="text-gray-500 text-xs -mt-2">CSV format: name, website (one per row)</p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs uppercase tracking-wide">
                    <th className="text-left pb-2 pr-4 w-8">#</th>
                    <th className="text-left pb-2 pr-4">Name</th>
                    <th className="text-left pb-2 pr-4">Website</th>
                    <th className="pb-2 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {contacts.map((c, i) => (
                    <tr key={c.id}>
                      <td className="py-2 pr-4 text-gray-600">{i + 1}</td>
                      <td className="py-2 pr-4">
                        <input
                          value={c.name}
                          onChange={(e) => updateField(c.id, "name", e.target.value)}
                          placeholder="Ahmad"
                          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 outline-none focus:border-purple-500 transition"
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          value={c.website}
                          onChange={(e) => updateField(c.id, "website", e.target.value)}
                          placeholder="https://example.com"
                          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 outline-none focus:border-purple-500 transition"
                        />
                      </td>
                      <td className="py-2">
                        <button onClick={() => removeRow(c.id)} className="text-gray-600 hover:text-red-400 transition text-lg leading-none">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button onClick={addRow} className="text-sm text-gray-400 hover:text-white transition w-fit">
              + Add row
            </button>
          </section>

          <button
            onClick={startScrollGeneration}
            disabled={validContacts.length === 0}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed py-3.5 rounded-xl font-semibold transition"
          >
            Generate Scroll Videos → ({validContacts.length} contacts)
          </button>
        </div>
      )}

      {/* ── STEP 2: Scroll generation ─────────────────────────────────────── */}
      {step === "scroll" && (
        <div className="w-full flex flex-col gap-6">
          <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="font-semibold text-lg">Generating website scroll videos</h2>
              <p className="text-gray-400 text-sm mt-0.5">Errors automatically fall back to tkrupt.com</p>
            </div>
            <div className="divide-y divide-gray-800">
              {contacts.filter((c) => c.name.trim()).map((c) => (
                <div key={c.id} className="px-6 py-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-gray-500 truncate">{c.website}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {c.scrollStatus === "idle" && <span className="text-xs text-gray-600">Pending</span>}
                    {c.scrollStatus === "queued" && (
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                        Queued…
                      </span>
                    )}
                    {c.scrollStatus === "generating" && (
                      <span className="text-xs text-yellow-400 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                        {c.isFallback ? "Fallback…" : "Generating…"}
                      </span>
                    )}
                    {c.scrollStatus === "done" && <span className="text-xs text-green-400">✓ Done</span>}
                    {c.scrollStatus === "error" && <span className="text-xs text-red-400">✗ Failed</span>}
                  </div>
                  {c.scrollStatus === "done" && c.scrollFilename && (
                    <video
                      src={`${API}/scroll-video/${c.scrollFilename}`}
                      className="w-64 h-36 rounded object-cover border border-gray-700 bg-black"
                      controls
                      preload="metadata"
                    />
                  )}
                </div>
              ))}
            </div>
          </section>

          <button
            onClick={() => goToStep("record")}
            disabled={!allScrollDone}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed py-3.5 rounded-xl font-semibold transition"
          >
            {allScrollDone ? "Record Your Pitch →" : "Waiting for scroll videos…"}
          </button>
          <button
            onClick={() => goToStep("contacts")}
            className="w-full bg-gray-800 hover:bg-gray-700 py-2.5 rounded-xl text-sm font-medium transition"
          >
            ← Back to Contacts
          </button>
        </div>
      )}

      {/* ── STEP 3: Record ───────────────────────────────────────────────── */}
      {step === "record" && (
        <div className="w-full flex flex-col gap-6">

          {/* Mode selector */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
            <h2 className="font-semibold text-lg">Choose recording mode</h2>
            <div className="grid grid-cols-2 gap-3">
              {(["face", "screen"] as RecordMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setRecordMode(m)}
                  className={`rounded-xl p-4 text-left border transition ${
                    recordMode === m
                      ? "border-purple-500 bg-purple-900/30"
                      : "border-gray-700 hover:border-gray-500"
                  }`}
                >
                  <p className="font-medium text-sm">{m === "face" ? "Website Background" : "Screen + Face"}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {m === "face"
                      ? "Face bubble only — scroll video becomes the background per contact"
                      : "Records your screen with face bubble bottom-left — same video for all"}
                  </p>
                </button>
              ))}
            </div>
          </section>

          {/* Camera preview + recording */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4">
            <h2 className="font-semibold text-lg">
              {isRecording ? `Recording… ${fmt(recordSec)}` : recordedUrl ? "Recording done" : "Camera preview"}
            </h2>

            {/* Face bubble preview */}
            <div className="relative bg-gray-800 rounded-xl overflow-hidden" style={{ aspectRatio: "16/9" }}>
              {recordMode === "face" && (
                <div className="absolute bottom-4 left-4 w-32 h-32 rounded-full overflow-hidden border-3 border-white shadow-lg z-10" style={{ borderWidth: 3 }}>
                  <video
                    ref={faceVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className="w-full h-full object-cover scale-x-[-1]"
                  />
                </div>
              )}
              {recordMode === "screen" && !isRecording && (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Screen capture starts when you hit Record
                  <div className="absolute bottom-4 left-4 w-24 h-24 rounded-full overflow-hidden border-3 border-white/50 shadow" style={{ borderWidth: 3 }}>
                    <video ref={faceVideoRef} autoPlay muted playsInline className="w-full h-full object-cover scale-x-[-1]" />
                  </div>
                </div>
              )}
              {recordMode === "screen" && isRecording && (
                <div className="flex items-center justify-center h-full text-yellow-400 text-sm font-medium animate-pulse">
                  Recording screen…
                </div>
              )}
            </div>

            <div className="flex gap-3 items-center">
              {!isRecording ? (
                <>
                  <button
                    onClick={startRecording}
                    className="bg-red-600 hover:bg-red-500 px-6 py-2.5 rounded-lg text-sm font-medium transition flex items-center gap-2"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-white" />
                    {recordedUrl ? "Re-record" : "Record"}
                  </button>
                  <label className="bg-gray-700 hover:bg-gray-600 px-4 py-2.5 rounded-lg text-sm font-medium transition cursor-pointer whitespace-nowrap">
                    Upload Pre-Recorded
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={handleRecordedVideoUpload}
                    />
                  </label>
                </>
              ) : (
                <button
                  onClick={stopRecording}
                  className="bg-gray-700 hover:bg-gray-600 px-6 py-2.5 rounded-lg text-sm font-medium transition"
                >
                  Stop
                </button>
              )}
              {recordedUrl && !isRecording && (
                <>
                  <video src={recordedUrl} controls className="flex-1 h-10 rounded" />
                  <a
                    href={recordedUrl}
                    download={`bubble-video-${Date.now()}.webm`}
                    className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap"
                  >
                    Download Bubble Video
                  </a>
                </>
              )}
            </div>
          </section>

          {/* Skip seconds (only relevant if voice file was provided) */}
          {voiceFile && (
            <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-2xl px-6 py-4">
              <div>
                <p className="text-sm font-medium">Skip first N seconds of voice reference</p>
                <p className="text-xs text-gray-500 mt-0.5">Trims your original "Hey" so the cloned greeting doesn't double up</p>
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
          )}

          <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-2xl px-6 py-4">
            <div>
              <p className="text-sm font-medium">Start scroll background from second N</p>
              <p className="text-xs text-gray-500 mt-0.5">Example: N=5 starts the website background from 00:05 in generated videos</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={scrollStartSeconds}
                onChange={(e) => setScrollStartSeconds(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-purple-500 text-center"
              />
              <span className="text-sm text-gray-400">sec</span>
            </div>
          </div>

          {recordMode === "screen" && (
            <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-2xl px-6 py-4">
              <div>
                <p className="text-sm font-medium">Screen zoom-out amount</p>
                <p className="text-xs text-gray-500 mt-0.5">Lower value = more zoomed out (default 90%).</p>
              </div>
              <div className="flex items-center gap-3 min-w-48">
                <input
                  type="range"
                  min={0.75}
                  max={1}
                  step={0.01}
                  value={screenScale}
                  onChange={(e) => setScreenScale(Number(e.target.value))}
                  className="w-28"
                />
                <span className="text-sm text-gray-300 w-12 text-right">{Math.round(screenScale * 100)}%</span>
              </div>
            </div>
          )}

          {error && <p className="text-red-400 text-sm">Error: {error}</p>}

          <button
            onClick={processVideos}
            disabled={!recordedBlob || isRecording}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed py-3.5 rounded-xl font-semibold transition"
          >
            {voiceFile
              ? `Process — ${isElevenLabsMode ? "ElevenLabs clone" : "clone voice"} + composite ${contacts.filter((c) => c.scrollFilename).length} videos →`
              : `Composite ${contacts.filter((c) => c.scrollFilename).length} videos →`}
          </button>
          <button
            onClick={() => goToStep("scroll")}
            className="w-full bg-gray-800 hover:bg-gray-700 py-2.5 rounded-xl text-sm font-medium transition"
          >
            ← Back to Scroll Videos
          </button>
        </div>
      )}

      {/* ── STEP 4: Results ──────────────────────────────────────────────── */}
      {step === "results" && (
        <div className="w-full flex flex-col gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
            <p className="text-sm font-medium">Re-generate with timing adjustments</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex items-center justify-between bg-gray-800 rounded-xl px-3 py-2">
                <span className="text-xs text-gray-300">Cloned intro / skip audio (sec)</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={skipSeconds}
                  onChange={(e) => setSkipSeconds(Number(e.target.value))}
                  className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-purple-500 text-center"
                />
              </div>
              <div className="flex items-center justify-between bg-gray-800 rounded-xl px-3 py-2">
                <span className="text-xs text-gray-300">Scroll start (sec)</span>
                <input
                  type="number"
                  min={0}
                  max={60}
                  step={0.5}
                  value={scrollStartSeconds}
                  onChange={(e) => setScrollStartSeconds(Number(e.target.value))}
                  className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-purple-500 text-center"
                />
              </div>
            </div>
            <button
              onClick={processVideos}
              disabled={!recordedBlob || isProcessing}
              className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed py-2.5 rounded-lg text-sm font-semibold transition"
            >
              {isProcessing ? "Re-generating videos..." : "Re-generate Videos With New Timings"}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-xl">
                {compositeJob?.status === "done" ? "All done!" : "Processing…"}
              </h2>
              {compositeJob && (
                <p className="text-gray-400 text-sm mt-0.5">
                  {compositeJob.done}/{compositeJob.total} videos
                  {compositeJob.current ? ` — cloning voice for ${compositeJob.current}…` : ""}
                </p>
              )}
            </div>
            {compositeJob?.status === "done" && compositeJobId && (
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadResultsCsv}
                  className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm transition"
                >
                  Download CSV
                </button>
                <a
                  href={`${API}/composite-download-all/${compositeJobId}`}
                  className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm transition"
                >
                  Download All (ZIP)
                </a>
              </div>
            )}
          </div>

          {compositeJob && (
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${(compositeJob.done / compositeJob.total) * 100}%` }}
              />
            </div>
          )}

          {error && <p className="text-red-400 text-sm">Error: {error}</p>}

          {isProcessing && (!compositeJob || compositeJob.done === 0) && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex items-center gap-3 text-sm text-gray-300">
              <span className="w-3 h-3 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
              Generating fresh videos with your new timing settings...
            </div>
          )}

          <div className="flex flex-col gap-4">
            {(compositeJob?.files || []).map((entry) => (
              <div key={entry.name} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{entry.name}</span>
                  {entry.error ? (
                    <span className="text-red-400 text-xs">{entry.error}</span>
                  ) : entry.filename ? (
                    <div className="flex items-center gap-3">
                      {(() => {
                        const shareUrl =
                          entry.preview_url ||
                          entry.public_url ||
                          entry.video_public_url ||
                          `${API}/download/${entry.filename}`;
                        const mp4Url = entry.video_public_url || `${API}/download/${entry.filename}`;
                        return (
                          <>
                            <a
                              href={shareUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-purple-400 hover:text-purple-300 text-xs transition"
                            >
                              Open
                            </a>
                            <a
                              href={mp4Url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-indigo-400 hover:text-indigo-300 text-xs transition"
                            >
                              Open MP4
                            </a>
                            <a
                              href={mp4Url}
                              download
                              className="text-blue-400 hover:text-blue-300 text-xs transition"
                            >
                              Download
                            </a>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
                {(entry.preview_url || entry.public_url || entry.video_public_url) && (
                  <div className="flex items-center gap-2">
                    {(() => {
                      const shareUrl =
                        entry.preview_url ||
                        entry.public_url ||
                        entry.video_public_url ||
                        `${API}/download/${entry.filename}`;
                      return (
                        <>
                          <input
                            readOnly
                            value={shareUrl}
                            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
                          />
                          <button
                            onClick={() => navigator.clipboard.writeText(shareUrl)}
                            className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs transition"
                          >
                            Copy URL
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
                {entry.filename && (
                  <video
                    src={entry.video_public_url || `${API}/download/${entry.filename}`}
                    controls
                    className="w-full rounded-lg border border-gray-700 bg-black max-h-64 object-contain"
                  />
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => goToStep("record")}
            className="w-full bg-gray-800 hover:bg-gray-700 py-2.5 rounded-xl text-sm font-medium transition"
          >
            ← Back to Record
          </button>
        </div>
      )}
    </main>
  );
}
