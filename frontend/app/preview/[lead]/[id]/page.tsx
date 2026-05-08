import type { Metadata } from "next";
import CopyButton from "./CopyButton";

type PreviewMetadata = {
  lead: string;
  preview_id: string;
  preview_path: string;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001").replace(/\/$/, "");

async function fetchPreviewMetadata(lead: string, id: string): Promise<PreviewMetadata> {
  const res = await fetch(`${API_URL}/preview/metadata/${lead}/${id}`, {
    next: { revalidate: 3600 }, // cache for 1 hour so OG scrapers don't hit a cold Render instance
  });
  if (!res.ok) throw new Error("Preview metadata not found");
  return res.json();
}

export async function generateMetadata({ params }: { params: { lead: string; id: string } }): Promise<Metadata> {
  try {
    const data = await fetchPreviewMetadata(params.lead, params.id);
    const previewUrl = `${APP_URL}${data.preview_path}`;
    return {
      title: data.title,
      description: data.description,
      openGraph: {
        title: data.title,
        description: data.description,
        url: previewUrl,
        type: "video.other",
        images: [{ url: data.thumbnail_url, width: 1280, height: 720, alt: data.title }],
        videos: [{ url: data.video_url, type: "video/mp4", width: 1280, height: 720 }],
      },
      twitter: {
        card: "summary_large_image",
        title: data.title,
        description: data.description,
        images: [data.thumbnail_url],
      },
    };
  } catch {
    return {
      title: "Personalized Video Preview",
      description: "A personalized outreach video created just for you.",
    };
  }
}

export default async function PreviewPage({ params }: { params: { lead: string; id: string } }) {
  const data = await fetchPreviewMetadata(params.lead, params.id);
  const previewUrl = `${APP_URL}${data.preview_path}`;

  return (
    <main className="min-h-screen bg-slate-950 text-white px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Video card */}
        <div className="rounded-3xl border border-slate-800 bg-slate-900/90 overflow-hidden shadow-xl shadow-slate-950/40">
          <video
            src={data.video_url}
            controls
            autoPlay
            muted
            poster={data.thumbnail_url}
            className="w-full bg-black"
          />
          <div className="p-6">
            <p className="text-xs uppercase tracking-widest text-slate-500">Personalized for you</p>
            <h1 className="mt-2 text-2xl font-semibold">{data.title}</h1>
            <p className="mt-2 text-slate-400 text-sm">{data.description}</p>
          </div>
        </div>

        {/* Share card */}
        <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-5">
          <p className="text-sm font-semibold text-slate-200">Share this video</p>
          <p className="mt-1 text-xs text-slate-500">
            This link shows a rich preview on WhatsApp, Slack, LinkedIn, and Telegram.
          </p>
          <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 break-all select-all">
            {previewUrl}
          </div>
          <CopyButton text={previewUrl} />
        </div>
      </div>
    </main>
  );
}
