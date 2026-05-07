import type { Metadata } from "next";

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
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";

async function fetchPreviewMetadata(lead: string, id: string): Promise<PreviewMetadata> {
  const res = await fetch(`${API_URL}/preview/metadata/${lead}/${id}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Preview metadata not found");
  }
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
        images: [{ url: data.thumbnail_url, alt: data.title }],
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
      description: "A shareable preview for a personalized outreach video.",
    };
  }
}

export default async function PreviewPage({ params }: { params: { lead: string; id: string } }) {
  const data = await fetchPreviewMetadata(params.lead, params.id);
  const previewUrl = `${APP_URL}${data.preview_path}`;

  return (
    <main className="min-h-screen bg-slate-950 text-white px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-8 shadow-xl shadow-slate-950/40">
          <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Personalized Video Preview</p>
          <h1 className="mt-4 text-3xl font-semibold">{data.title}</h1>
          <p className="mt-3 text-slate-300">{data.description}</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_280px]">
            <div className="rounded-3xl overflow-hidden border border-slate-800 bg-black">
              <video
                src={data.video_url}
                controls
                className="w-full max-h-[420px] bg-black"
              />
            </div>
            <div className="rounded-3xl border border-slate-800 bg-slate-950 p-4">
              <p className="text-sm text-slate-400">Share preview link</p>
              <div className="mt-3 rounded-2xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 break-all">
                {previewUrl}
              </div>
              <a
                href={data.thumbnail_url}
                target="_blank"
                rel="noreferrer"
                className="mt-6 inline-flex items-center justify-center w-full rounded-2xl bg-purple-600 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-500 transition"
              >
                Open Thumbnail
              </a>
            </div>
          </div>
        </div>
        <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
          <p className="text-sm text-slate-400">This URL is designed for social preview scrapers like Slack, WhatsApp, LinkedIn, and Telegram. It includes Open Graph metadata and a thumbnail image.</p>
        </div>
      </div>
    </main>
  );
}
