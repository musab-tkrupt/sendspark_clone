import asyncio
import html
import json
import mimetypes
import os
import re
import subprocess
import time
import uuid
import zipfile
from io import BytesIO

import httpx
import torch
import torchaudio
from chatterbox.tts import ChatterboxTTS
from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from supabase import Client, create_client

app = FastAPI()



app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model: ChatterboxTTS | None = None
jobs: dict = {}
composite_jobs: dict = {}

BACKEND_ROOT = os.path.abspath(os.path.dirname(__file__))

os.makedirs("temp", exist_ok=True)
os.makedirs("outputs", exist_ok=True)


def _load_local_env() -> None:
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_local_env()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "Videos").strip()
SUPABASE_PATH_PREFIX = os.getenv("SUPABASE_PATH_PREFIX", "sendspark").strip().strip("/")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()
ELEVENLABS_OUTPUT_FORMAT = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128").strip()
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://tkrupt.com").strip().rstrip("/")
SCROLL_STATUS_STALE_SECONDS = int(os.getenv("SCROLL_STATUS_STALE_SECONDS", "90"))
ENABLE_CHATTERBOX = os.getenv("ENABLE_CHATTERBOX", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

supabase_client: Client | None = None
if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _supabase_object_key(filename: str, category: str) -> str:
    base = f"{category}/{filename}" if category else filename
    if SUPABASE_PATH_PREFIX:
        return f"{SUPABASE_PATH_PREFIX}/{base}"
    return base


def _upload_file_to_supabase(local_path: str, object_key: str) -> str | None:
    if not supabase_client or not SUPABASE_STORAGE_BUCKET:
        return None
    ext = os.path.splitext(local_path)[1].lower()
    forced_types = {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".mp4": "video/mp4",
        ".gif": "image/gif",
    }
    content_type = forced_types.get(ext) or mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    with open(local_path, "rb") as f:
        supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
            path=object_key,
            file=f,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    return supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(object_key)


def _supabase_public_url(object_key: str) -> str | None:
    if not supabase_client or not SUPABASE_STORAGE_BUCKET:
        return None
    return supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(object_key)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "lead"


def _preview_bundle_storage_key(lead_slug: str, preview_id: str, filename: str) -> str:
    """Public preview files live at previews/... (no SUPABASE_PATH_PREFIX) for clean direct URLs."""
    return f"previews/{lead_slug}/{preview_id}/{filename}"


def _preview_object_keys(lead_slug: str, preview_id: str) -> dict[str, str]:
    return {
        "video": _preview_bundle_storage_key(lead_slug, preview_id, "video.mp4"),
        "thumbnail": _preview_bundle_storage_key(lead_slug, preview_id, "thumbnail.jpg"),
        "html": _preview_bundle_storage_key(lead_slug, preview_id, "index.html"),
        "gif": _preview_bundle_storage_key(lead_slug, preview_id, "preview.gif"),
        "gif_preview_html": _preview_bundle_storage_key(lead_slug, preview_id, "gif-preview.html"),
    }


def _frontend_preview_url(lead_slug: str, preview_id: str) -> str | None:
    if not FRONTEND_URL:
        return None
    return f"{FRONTEND_URL}/v/{lead_slug}/{preview_id}"


def _compose_email_html_snippet(video_public_url: str | None, gif_url: str | None) -> str | None:
    """HTML email snippet: anchor = full MP4, image = GIF."""
    if not video_public_url or not gif_url:
        return None
    safe_v = html.escape(video_public_url, quote=True)
    safe_g = html.escape(gif_url, quote=True)
    return (
        f'<a href="{safe_v}" target="_blank">\n'
        f'  <img src="{safe_g}" width="600" style="display:block; border:0;" />\n'
        "</a>"
    )


def _extract_thumbnail(video_path: str, thumbnail_path: str) -> None:
    duration = 0.0
    try:
        duration = _get_duration(video_path)
    except Exception:
        duration = 0.0
    timestamp = 1.0 if duration <= 0 else max(0.0, min(duration * 0.5, max(duration - 0.1, 0.0)))

    # Extract raw frame first, then composite a play button over it.
    raw_path = thumbnail_path + "_raw.jpg"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", f"{timestamp:.3f}",
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            raw_path,
        ],
        check=True,
        capture_output=True,
    )

    # Overlay a semi-transparent dark circle with a white play triangle.
    # drawellipse fills the circle; drawtext draws "▶" centred inside it.
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", raw_path,
                "-vf",
                (
                    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.25:t=fill,"
                    "drawellipse=x=iw/2-60:y=ih/2-60:w=120:h=120:color=black@0.55:t=fill,"
                    "drawtext=text='▶':fontsize=52:fontcolor=white@0.95"
                    ":x=(w-text_w)/2+6:y=(h-text_h)/2"
                ),
                "-frames:v", "1",
                "-q:v", "2",
                thumbnail_path,
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        # drawellipse / drawtext unavailable on this ffmpeg build — use raw frame.
        os.rename(raw_path, thumbnail_path)
        return
    finally:
        if os.path.exists(raw_path):
            os.remove(raw_path)


def _build_preview_html(
    lead_name: str,
    preview_url: str,
    video_url: str,
    thumbnail_url: str,
    video_width: int = 1280,
    video_height: int = 720,
) -> str:
    safe_name = html.escape(lead_name)
    safe_preview_url = html.escape(preview_url)
    safe_video_url = html.escape(video_url)
    safe_thumbnail_url = html.escape(thumbnail_url)
    title = f"{lead_name} - Personalized Video"
    description = f"A personalized video message for {lead_name}."
    safe_title = html.escape(title)
    safe_description = html.escape(description)
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{safe_title}</title>
    <meta name="description" content="{safe_description}" />
    <meta property="og:title" content="{safe_title}" />
    <meta property="og:description" content="{safe_description}" />
    <meta property="og:type" content="video.other" />
    <meta property="og:url" content="{safe_preview_url}" />
    <meta property="og:image" content="{safe_thumbnail_url}" />
    <meta property="og:image:width" content="{video_width}" />
    <meta property="og:image:height" content="{video_height}" />
    <meta property="og:video" content="{safe_video_url}" />
    <meta property="og:video:secure_url" content="{safe_video_url}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta property="og:video:width" content="{video_width}" />
    <meta property="og:video:height" content="{video_height}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{safe_title}" />
    <meta name="twitter:description" content="{safe_description}" />
    <meta name="twitter:image" content="{safe_thumbnail_url}" />
    <style>
      *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
      html, body {{ height: 100%; background: #0b0f1a; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
      body {{ display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 16px; }}
      .card {{ width: 100%; max-width: 860px; }}
      .meta {{ margin-bottom: 16px; }}
      .meta h1 {{ font-size: clamp(18px, 3vw, 26px); font-weight: 700; letter-spacing: -0.3px; }}
      .meta p {{ font-size: 14px; color: #94a3b8; margin-top: 4px; }}
      .player-wrap {{ position: relative; width: 100%; border-radius: 14px; overflow: hidden; background: #000; box-shadow: 0 24px 64px rgba(0,0,0,0.6); cursor: pointer; }}
      .player-wrap video {{ width: 100%; display: block; }}
      .play-overlay {{
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.3); transition: opacity 0.2s;
      }}
      .play-overlay.hidden {{ opacity: 0; pointer-events: none; }}
      .play-btn {{
        width: 80px; height: 80px; border-radius: 50%;
        background: rgba(255,255,255,0.15); backdrop-filter: blur(6px);
        border: 2px solid rgba(255,255,255,0.4);
        display: flex; align-items: center; justify-content: center;
        transition: transform 0.15s, background 0.15s;
      }}
      .play-btn svg {{ width: 32px; height: 32px; fill: white; margin-left: 4px; }}
      .player-wrap:hover .play-btn {{ transform: scale(1.08); background: rgba(255,255,255,0.25); }}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="meta">
        <h1>Video for {safe_name}</h1>
        <p>Click to watch your personalized message.</p>
      </div>
      <div class="player-wrap" id="wrap">
        <video id="vid" controls playsinline preload="metadata" poster="{safe_thumbnail_url}">
          <source src="{safe_video_url}" type="video/mp4" />
        </video>
        <div class="play-overlay" id="overlay">
          <div class="play-btn">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      </div>
    </div>
    <script>
      var vid = document.getElementById('vid');
      var overlay = document.getElementById('overlay');
      document.getElementById('wrap').addEventListener('click', function() {{
        overlay.classList.add('hidden');
        vid.play();
      }});
      vid.addEventListener('pause', function() {{ overlay.classList.remove('hidden'); }});
      vid.addEventListener('ended', function() {{ overlay.classList.remove('hidden'); }});
    </script>
  </body>
</html>
"""


def _build_gif_preview_html(
    lead_name: str,
    page_url: str,
    video_url: str,
    gif_url: str,
    gif_width: int = 600,
    gif_height: int = 338,
) -> str:
    """Standalone share page: Open Graph / Twitter image point at the animated GIF."""
    safe_name = html.escape(lead_name)
    safe_page_url = html.escape(page_url)
    safe_video_url = html.escape(video_url)
    safe_gif_url = html.escape(gif_url)
    title = f"{lead_name} - Personalized Video (preview)"
    description = f"A personalized video message for {lead_name}."
    safe_title = html.escape(title)
    safe_description = html.escape(description)
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{safe_title}</title>
    <meta name="description" content="{safe_description}" />
    <meta property="og:title" content="{safe_title}" />
    <meta property="og:description" content="{safe_description}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="{safe_page_url}" />
    <meta property="og:image" content="{safe_gif_url}" />
    <meta property="og:image:type" content="image/gif" />
    <meta property="og:image:width" content="{gif_width}" />
    <meta property="og:image:height" content="{gif_height}" />
    <meta property="og:video" content="{safe_video_url}" />
    <meta property="og:video:secure_url" content="{safe_video_url}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{safe_title}" />
    <meta name="twitter:description" content="{safe_description}" />
    <meta name="twitter:image" content="{safe_gif_url}" />
    <style>
      *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
      html, body {{ height: 100%; background: #0b0f1a; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
      body {{ display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 16px; }}
      .card {{ width: 100%; max-width: 720px; text-align: center; }}
      .meta {{ margin-bottom: 16px; }}
      .meta h1 {{ font-size: clamp(18px, 3vw, 26px); font-weight: 700; letter-spacing: -0.3px; }}
      .meta p {{ font-size: 14px; color: #94a3b8; margin-top: 4px; }}
      .gif-wrap {{ display: inline-block; border-radius: 14px; overflow: hidden; background: #000; box-shadow: 0 24px 64px rgba(0,0,0,0.6); }}
      .gif-wrap img {{ display: block; max-width: 100%; height: auto; vertical-align: middle; }}
      .cta {{ margin-top: 20px; }}
      .cta a {{
        display: inline-block; padding: 12px 22px; border-radius: 10px;
        background: #7c3aed; color: #fff; font-weight: 600; text-decoration: none; font-size: 14px;
      }}
      .cta a:hover {{ background: #6d28d9; }}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="meta">
        <h1>Video for {safe_name}</h1>
        <p>Preview loops below — tap to watch the full video.</p>
      </div>
      <a class="gif-wrap" href="{safe_video_url}">
        <img src="{safe_gif_url}" alt="Video preview for {safe_name}" width="{gif_width}" height="{gif_height}" />
      </a>
      <div class="cta">
        <a href="{safe_video_url}">Watch full video</a>
      </div>
    </div>
  </body>
</html>
"""


def _format_duration_badge(total_sec: float) -> str:
    if total_sec < 0:
        total_sec = 0.0
    total_sec = int(round(total_sec))
    m, s = total_sec // 60, total_sec % 60
    if m >= 60:
        h, m = m // 60, m % 60
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _drawtext_escape(text: str) -> str:
    """Escape text for ffmpeg drawtext text=... filter argument."""
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "")
        .replace("%", "\\%")
    )


def _gif_clip_bounds(video_path: str, gif_start: float, gif_end: float) -> tuple[float, float]:
    """Returns (start_sec, end_sec) on the source timeline; end is exclusive; max clip 15s."""
    dur = max(_get_duration(video_path), 0.01)
    start = max(0.0, min(float(gif_start), dur - 0.05))
    end = float(gif_end)
    if end <= start:
        end = start + min(4.0, dur - start)
    end = min(end, dur)
    if end <= start + 0.05:
        start, end = 0.0, min(4.0, dur)
    max_len = 15.0
    if end - start > max_len:
        end = start + max_len
    return start, end


def _build_email_preview_gif(
    local_video_path: str,
    output_gif_path: str,
    gif_start: float,
    gif_end: float,
) -> None:
    """Short looping GIF for email: trim, scale to ~600px wide, fps 10, palette, play + duration overlays."""
    start, end = _gif_clip_bounds(local_video_path, gif_start, gif_end)
    clip_dur = end - start
    full_dur = _get_duration(local_video_path)
    badge = _drawtext_escape(_format_duration_badge(full_dur))

    base_chain = (
        f"trim=start={start}:duration={clip_dur},setpts=PTS-STARTPTS,"
        f"fps=10,scale=600:-2:flags=lanczos,"
        f"drawellipse=x=(iw/2-44):y=(ih/2-44):w=88:h=88:color=black@0.55:t=fill,"
        f"drawtext=text='▶':fontsize=38:fontcolor=white@0.95:x=(w-text_w)/2+5:y=(h-text_h)/2,"
        f"drawtext=text='{badge}':fontsize=15:fontcolor=white:x=w-tw-10:y=h-th-8:"
        f"box=1:boxcolor=black@0.55:boxborderw=4"
    )
    palette_chain = (
        f"{base_chain},split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];"
        f"[s1][p]paletteuse=dither=bayer:bayer_scale=3"
    )
    simple_palette = (
        f"trim=start={start}:duration={clip_dur},setpts=PTS-STARTPTS,"
        f"fps=10,scale=600:-2:flags=lanczos,split[s0][s1];"
        f"[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
    )
    for lavfi in (palette_chain, simple_palette):
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    local_video_path,
                    "-lavfi",
                    lavfi,
                    "-loop",
                    "0",
                    output_gif_path,
                ],
                check=True,
                capture_output=True,
            )
            return
        except subprocess.CalledProcessError:
            if lavfi is simple_palette:
                raise


def _upload_lead_preview_assets(
    local_video_path: str,
    lead_name: str,
    gif_start_seconds: float = 0.0,
    gif_end_seconds: float = 4.0,
) -> dict[str, str | None]:
    lead_slug = _slugify(lead_name)
    preview_id = str(uuid.uuid4())
    result: dict[str, str | None] = {
        "lead_slug": lead_slug,
        "preview_id": preview_id,
        "preview_url": None,
        "vercel_preview_url": _frontend_preview_url(lead_slug, preview_id),
        "supabase_preview_url": None,
        "image_preview_html_url": None,
        "gif_preview_html_url": None,
        "video_public_url": None,
        "thumbnail_public_url": None,
        "gif_public_url": None,
        "email_gif_url": None,
        "email_html_snippet": None,
    }
    if not supabase_client or not SUPABASE_STORAGE_BUCKET:
        return result

    keys = _preview_object_keys(lead_slug, preview_id)
    video_key = keys["video"]
    thumb_key = keys["thumbnail"]
    html_key = keys["html"]
    gif_key = keys["gif"]
    gif_html_key = keys["gif_preview_html"]

    expected_video_url = _supabase_public_url(video_key) or ""
    expected_thumb_url = _supabase_public_url(thumb_key) or ""
    expected_preview_url = _supabase_public_url(html_key) or ""
    expected_gif_url = _supabase_public_url(gif_key) or ""
    expected_gif_preview_page_url = _supabase_public_url(gif_html_key) or ""

    temp_thumb_path = os.path.join(BACKEND_ROOT, "temp", f"{preview_id}_thumbnail.jpg")
    temp_html_path = os.path.join(BACKEND_ROOT, "temp", f"{preview_id}_index.html")
    temp_gif_path = os.path.join(BACKEND_ROOT, "temp", f"{preview_id}_email.gif")
    temp_gif_preview_html_path = os.path.join(BACKEND_ROOT, "temp", f"{preview_id}_gif_preview.html")
    try:
        _extract_thumbnail(local_video_path, temp_thumb_path)
        try:
            vw, vh = _get_video_size(local_video_path)
            video_width, video_height = int(vw), int(vh)
        except Exception:
            video_width, video_height = 1280, 720
        preview_html = _build_preview_html(
            lead_name=lead_name,
            preview_url=expected_preview_url,
            video_url=expected_video_url,
            thumbnail_url=expected_thumb_url,
            video_width=video_width,
            video_height=video_height,
        )
        with open(temp_html_path, "w", encoding="utf-8") as f:
            f.write(preview_html)

        result["video_public_url"] = _upload_file_to_supabase(local_video_path, video_key)
        result["thumbnail_public_url"] = _upload_file_to_supabase(temp_thumb_path, thumb_key)
        html_preview_url = _upload_file_to_supabase(temp_html_path, html_key)
        result["supabase_preview_url"] = html_preview_url
        result["image_preview_html_url"] = html_preview_url
        result["preview_url"] = (
            result["image_preview_html_url"] or result["vercel_preview_url"] or result["video_public_url"]
        )

        gif_w, gif_h = 600, max(2, int(round(600 * video_height / max(video_width, 1))))
        try:
            _build_email_preview_gif(
                local_video_path, temp_gif_path, gif_start_seconds, gif_end_seconds
            )
            gif_url = _upload_file_to_supabase(temp_gif_path, gif_key)
            result["gif_public_url"] = gif_url
            result["email_gif_url"] = gif_url
            gif_for_meta = gif_url or expected_gif_url
            gif_preview_body = _build_gif_preview_html(
                lead_name,
                expected_gif_preview_page_url,
                expected_video_url,
                gif_for_meta,
                gif_w,
                gif_h,
            )
            with open(temp_gif_preview_html_path, "w", encoding="utf-8") as f:
                f.write(gif_preview_body)
            result["gif_preview_html_url"] = _upload_file_to_supabase(
                temp_gif_preview_html_path, gif_html_key
            )
        except Exception:
            result["gif_public_url"] = None
            result["email_gif_url"] = None
            result["gif_preview_html_url"] = None

        result["email_html_snippet"] = _compose_email_html_snippet(
            result.get("video_public_url"),
            result.get("email_gif_url") or result.get("gif_public_url"),
        )

        return result
    finally:
        if os.path.exists(temp_thumb_path):
            os.remove(temp_thumb_path)
        if os.path.exists(temp_html_path):
            os.remove(temp_html_path)
        if os.path.exists(temp_gif_path):
            os.remove(temp_gif_path)
        if os.path.exists(temp_gif_preview_html_path):
            os.remove(temp_gif_preview_html_path)


@app.get("/preview/metadata/{lead_slug}/{preview_id}")
def preview_metadata(lead_slug: str, preview_id: str):
    if not supabase_client or not SUPABASE_STORAGE_BUCKET:
        return JSONResponse({"error": "preview storage is not configured"}, status_code=503)
    safe_lead = _slugify(lead_slug)
    safe_preview = str(preview_id).strip()
    keys = _preview_object_keys(safe_lead, safe_preview)
    video_url = _supabase_public_url(keys["video"])
    thumbnail_url = _supabase_public_url(keys["thumbnail"])
    if not video_url or not thumbnail_url:
        return JSONResponse({"error": "preview assets not found"}, status_code=404)
    display_name = safe_lead.replace("-", " ").title()
    title = f"{display_name} - Personalized Video"
    description = f"A personalized video message for {display_name}."
    return {
        "lead_slug": safe_lead,
        "preview_id": safe_preview,
        "title": title,
        "description": description,
        "video_url": video_url,
        "thumbnail_url": thumbnail_url,
        "canonical_url": _frontend_preview_url(safe_lead, safe_preview) or _supabase_public_url(keys["html"]),
    }


def _elevenlabs_headers() -> dict[str, str]:
    if not ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY is missing in backend .env")
    return {"xi-api-key": ELEVENLABS_API_KEY}


def _elevenlabs_create_ivc_voice(sample_audio_path: str, voice_name: str) -> str:
    normalized_path = sample_audio_path
    if not sample_audio_path.lower().endswith(".wav"):
        normalized_path = f"{os.path.splitext(sample_audio_path)[0]}_elevenlabs.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                sample_audio_path,
                "-ac",
                "1",
                "-ar",
                "44100",
                normalized_path,
            ],
            check=True,
            capture_output=True,
        )

    with open(normalized_path, "rb") as sample_file:
        files = [
            (
                "files",
                (
                    os.path.basename(normalized_path),
                    sample_file,
                    "audio/wav",
                ),
            )
        ]
        data = {"name": voice_name[:48], "remove_background_noise": "false"}
        response = httpx.post(
            "https://api.elevenlabs.io/v1/voices/add",
            headers=_elevenlabs_headers(),
            data=data,
            files=files,
            timeout=120,
        )
    if response.status_code >= 400:
        details = response.text.strip()
        raise RuntimeError(
            f"ElevenLabs voice clone failed ({response.status_code}): {details or 'No details provided'}"
        )
    payload = response.json()
    voice_id = (payload or {}).get("voice_id")
    if not voice_id:
        raise RuntimeError("ElevenLabs did not return a voice_id")
    return voice_id


def _elevenlabs_tts_to_file(voice_id: str, text: str, output_path: str) -> None:
    response = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": ELEVENLABS_OUTPUT_FORMAT},
        headers={
            **_elevenlabs_headers(),
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": ELEVENLABS_MODEL_ID,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        },
        timeout=120,
    )
    response.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(response.content)


def _elevenlabs_delete_voice(voice_id: str) -> None:
    response = httpx.delete(
        f"https://api.elevenlabs.io/v1/voices/{voice_id}",
        headers=_elevenlabs_headers(),
        timeout=60,
    )
    response.raise_for_status()


def _elevenlabs_models() -> list[dict]:
    response = httpx.get(
        "https://api.elevenlabs.io/v1/models",
        headers=_elevenlabs_headers(),
        timeout=30,
    )
    response.raise_for_status()
    models = response.json()
    return models if isinstance(models, list) else []


# ── Startup ──────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def load_model():
    global model
    if not ENABLE_CHATTERBOX:
        print("Chatterbox disabled (ENABLE_CHATTERBOX=false). Skipping model load.")
        return
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Chatterbox on {device}…")
    try:
        model = await asyncio.to_thread(ChatterboxTTS.from_pretrained, device)
        print("Model ready.")
    except Exception as exc:
        model = None
        print(f"Chatterbox failed to load; continuing without it: {exc}")


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.get("/elevenlabs/models")
def elevenlabs_models():
    if not ELEVENLABS_API_KEY:
        return JSONResponse({"error": "ELEVENLABS_API_KEY is missing"}, status_code=503)
    try:
        models = _elevenlabs_models()
        return {"count": len(models), "models": models}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


@app.post("/elevenlabs/test-tts")
async def elevenlabs_test_tts(
    text: str = Form("Hello from ElevenLabs test."),
    voice_id: str = Form(...),
):
    if not ELEVENLABS_API_KEY:
        return JSONResponse({"error": "ELEVENLABS_API_KEY is missing"}, status_code=503)
    out_fn = f"elevenlabs-test-{uuid.uuid4()}.mp3"
    out_path = os.path.join(BACKEND_ROOT, "outputs", out_fn)
    try:
        await asyncio.to_thread(_elevenlabs_tts_to_file, voice_id.strip(), text.strip(), out_path)
        return {"filename": out_fn, "download_url": f"/download/{out_fn}"}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


@app.post("/elevenlabs/test-clone")
async def elevenlabs_test_clone(
    sample_audio: UploadFile = File(...),
    name: str = Form("cursor-test-voice"),
    delete_after_test: bool = Form(True),
):
    if not ELEVENLABS_API_KEY:
        return JSONResponse({"error": "ELEVENLABS_API_KEY is missing"}, status_code=503)

    ext = os.path.splitext(sample_audio.filename or "")[1] or ".wav"
    sample_path = os.path.join(BACKEND_ROOT, "temp", f"elevenlabs-sample-{uuid.uuid4()}{ext}")
    with open(sample_path, "wb") as f:
        f.write(await sample_audio.read())

    voice_id: str | None = None
    deleted = False
    try:
        voice_id = await asyncio.to_thread(_elevenlabs_create_ivc_voice, sample_path, name)
        return_payload = {"voice_id": voice_id, "deleted": False}
        if delete_after_test:
            await asyncio.to_thread(_elevenlabs_delete_voice, voice_id)
            deleted = True
            return_payload["deleted"] = True
        return return_payload
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        try:
            if os.path.exists(sample_path):
                os.remove(sample_path)
        except Exception:
            pass
        if voice_id and delete_after_test and not deleted:
            try:
                await asyncio.to_thread(_elevenlabs_delete_voice, voice_id)
            except Exception:
                pass


@app.get("/dependency-check")
def dependency_check():
    required = {
        "SUPABASE_URL": bool(SUPABASE_URL),
        "SUPABASE_SERVICE_ROLE_KEY": bool(SUPABASE_SERVICE_ROLE_KEY),
        "SUPABASE_STORAGE_BUCKET": bool(SUPABASE_STORAGE_BUCKET),
        "SUPABASE_PATH_PREFIX": bool(SUPABASE_PATH_PREFIX),
    }
    writable = False
    public_url = None
    error = None
    if supabase_client and SUPABASE_STORAGE_BUCKET:
        try:
            key = _supabase_object_key(f"dependency-check-{uuid.uuid4()}.txt", "checks")
            data = b"dependency check"
            supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
                path=key,
                file=data,
                file_options={"content-type": "text/plain", "upsert": "true"},
            )
            public_url = supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(key)
            writable = True
        except Exception as exc:
            error = str(exc)

    elevenlabs_required = {
        "ELEVENLABS_API_KEY": bool(ELEVENLABS_API_KEY),
    }
    elevenlabs_api_ok = False
    elevenlabs_error = None
    elevenlabs_model_available = False
    if ELEVENLABS_API_KEY:
        try:
            models = _elevenlabs_models()
            elevenlabs_api_ok = True
            elevenlabs_model_available = any(
                (m.get("model_id") == ELEVENLABS_MODEL_ID) for m in models if isinstance(m, dict)
            )
        except Exception as exc:
            elevenlabs_error = str(exc)

    return {
        "supabase_configured": bool(supabase_client),
        "required_vars_present": required,
        "bucket": SUPABASE_STORAGE_BUCKET,
        "path_prefix": SUPABASE_PATH_PREFIX,
        "storage_write_ok": writable,
        "test_public_url": public_url,
        "error": error,
        "elevenlabs_configured": bool(ELEVENLABS_API_KEY),
        "elevenlabs_required_vars_present": elevenlabs_required,
        "elevenlabs_api_ok": elevenlabs_api_ok,
        "elevenlabs_model_id": ELEVENLABS_MODEL_ID,
        "elevenlabs_model_available": elevenlabs_model_available,
        "elevenlabs_output_format": ELEVENLABS_OUTPUT_FORMAT,
        "elevenlabs_error": elevenlabs_error,
    }


# ── Voice cloning ─────────────────────────────────────────────────────────────

@app.post("/generate")
async def generate(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    names: str = Form(...),
    video: UploadFile = File(None),
    skip_seconds: float = Form(3.0),
):
    if model is None:
        return JSONResponse({"error": "Model not loaded yet"}, status_code=503)

    job_id = str(uuid.uuid4())

    ref_ext = os.path.splitext(audio.filename or "")[1] or ".wav"
    ref_path = f"temp/{job_id}_ref{ref_ext}"
    with open(ref_path, "wb") as f:
        f.write(await audio.read())

    video_path = None
    if video and video.filename:
        vid_ext = os.path.splitext(video.filename)[1] or ".mp4"
        video_path = f"temp/{job_id}_original{vid_ext}"
        with open(video_path, "wb") as f:
            f.write(await video.read())

    name_list = [n.strip() for n in names.replace("\n", ",").split(",") if n.strip()]

    jobs[job_id] = {
        "status": "processing",
        "total": len(name_list),
        "done": 0,
        "current": None,
        "files": [],
        "has_video": video_path is not None,
    }

    background_tasks.add_task(run_generation, job_id, ref_path, name_list, video_path, skip_seconds)
    return {"jobId": job_id}


def _generate_one(text: str, ref_path: str) -> tuple:
    wav = model.generate(
        text,
        audio_prompt_path=ref_path,
        exaggeration=0.5,
        cfg_weight=0.5,
    )
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    return wav, model.sr


async def run_generation(
    job_id: str,
    ref_path: str,
    names: list[str],
    video_path: str | None,
    skip_seconds: float = 3.0,
):
    for name in names:
        jobs[job_id]["current"] = name
        try:
            wav, sr = await asyncio.to_thread(_generate_one, f"Hey {name}", ref_path)
            safe = name.lower().replace(" ", "-")
            wav_filename = f"{job_id}_{safe}.wav"
            wav_path = f"outputs/{wav_filename}"
            await asyncio.to_thread(torchaudio.save, wav_path, wav, sr)

            concat_filename = f"{job_id}_{safe}_full.wav"
            concat_path = f"outputs/{concat_filename}"
            await asyncio.to_thread(_concat_audio, wav_path, ref_path, concat_path, skip_seconds)

            entry: dict = {"name": name, "filename": wav_filename, "concat_filename": concat_filename}

            if video_path:
                mp4_filename = f"{job_id}_{safe}.mp4"
                mp4_path = f"outputs/{mp4_filename}"
                await asyncio.to_thread(_merge_hey_with_video, wav_path, video_path, mp4_path)
                entry["video_filename"] = mp4_filename
                try:
                    object_key = _supabase_object_key(mp4_filename, "voice-cloner")
                    entry["video_public_url"] = await asyncio.to_thread(
                        _upload_file_to_supabase, mp4_path, object_key
                    )
                except Exception:
                    entry["video_public_url"] = None

            jobs[job_id]["files"].append(entry)
        except Exception as e:
            jobs[job_id]["files"].append({"name": name, "error": str(e)})
        jobs[job_id]["done"] += 1

    jobs[job_id]["status"] = "done"
    jobs[job_id]["current"] = None


@app.get("/status/{job_id}")
def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"status": "not_found"}, status_code=404)
    return job


# ── Scroll video generation (reuses SS_Clone_2.0 scripts) ────────────────────

@app.post("/scroll")
async def generate_scroll(url: str = Form(...)):
    job_id = str(uuid.uuid4())
    jobs_dir = os.path.join(BACKEND_ROOT, ".jobs")
    os.makedirs(jobs_dir, exist_ok=True)
    with open(os.path.join(jobs_dir, f"{job_id}.json"), "w") as f:
        json.dump({"status": "recording"}, f)

    # Keep a per-job recorder log so failed Puppeteer runs are debuggable.
    log_path = os.path.join(jobs_dir, f"{job_id}.log")
    log_file = open(log_path, "ab")
    subprocess.Popen(
        ["node", "scripts/record-paged.js", url, job_id],
        cwd=BACKEND_ROOT,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    log_file.close()
    return {"jobId": job_id}


@app.get("/scroll-status/{job_id}")
def scroll_status(job_id: str):
    job_file = os.path.join(BACKEND_ROOT, ".jobs", f"{job_id}.json")
    if not os.path.exists(job_file):
        return JSONResponse({"status": "not_found"}, status_code=404)
    with open(job_file) as f:
        data = json.load(f)

    if data.get("status") == "recording":
        last_write = os.path.getmtime(job_file)
        stale_for = time.time() - last_write
        if stale_for > SCROLL_STATUS_STALE_SECONDS:
            data = {
                "status": "error",
                "error": (
                    "Scroll recorder timed out. Check .jobs/"
                    f"{job_id}.log for details."
                ),
            }
            with open(job_file, "w") as f:
                json.dump(data, f)
    return data


@app.get("/scroll-video/{filename}")
def scroll_video(filename: str):
    filename = os.path.basename(filename)
    path = os.path.join(BACKEND_ROOT, "outputs", filename)
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4")


# ── SendSpark composite pipeline ──────────────────────────────────────────────

@app.post("/composite")
async def composite_videos(
    background_tasks: BackgroundTasks,
    face: UploadFile = File(...),
    ref_audio: UploadFile = File(None),
    contacts: str = Form(...),
    skip_seconds: float = Form(3.0),
    scroll_start_seconds: float = Form(0.0),
    gif_start_seconds: float = Form(0.0),
    gif_end_seconds: float = Form(4.0),
):
    job_id = str(uuid.uuid4())

    face_ext = os.path.splitext(face.filename or "")[1] or ".webm"
    face_path = f"temp/{job_id}_face{face_ext}"
    with open(face_path, "wb") as f:
        f.write(await face.read())

    ref_audio_path = None
    if ref_audio and ref_audio.filename:
        ref_ext = os.path.splitext(ref_audio.filename)[1] or ".wav"
        ref_audio_path = f"temp/{job_id}_voice{ref_ext}"
        with open(ref_audio_path, "wb") as f:
            f.write(await ref_audio.read())

    contact_list = json.loads(contacts)

    composite_jobs[job_id] = {
        "status": "processing",
        "total": len(contact_list),
        "done": 0,
        "current": None,
        "files": [],
    }

    background_tasks.add_task(
        run_composite,
        job_id,
        face_path,
        ref_audio_path,
        contact_list,
        skip_seconds,
        scroll_start_seconds,
        gif_start_seconds,
        gif_end_seconds,
    )
    return {"jobId": job_id}


@app.post("/composite-elevenlabs")
async def composite_videos_elevenlabs(
    background_tasks: BackgroundTasks,
    face: UploadFile = File(...),
    ref_audio: UploadFile = File(...),
    contacts: str = Form(...),
    skip_seconds: float = Form(3.0),
    scroll_start_seconds: float = Form(0.0),
    gif_start_seconds: float = Form(0.0),
    gif_end_seconds: float = Form(4.0),
):
    if not ELEVENLABS_API_KEY:
        return JSONResponse({"error": "ELEVENLABS_API_KEY is not configured"}, status_code=503)

    job_id = str(uuid.uuid4())

    face_ext = os.path.splitext(face.filename or "")[1] or ".webm"
    face_path = f"temp/{job_id}_face{face_ext}"
    with open(face_path, "wb") as f:
        f.write(await face.read())

    ref_ext = os.path.splitext(ref_audio.filename or "")[1] or ".wav"
    ref_audio_path = f"temp/{job_id}_voice{ref_ext}"
    with open(ref_audio_path, "wb") as f:
        f.write(await ref_audio.read())

    contact_list = json.loads(contacts)

    composite_jobs[job_id] = {
        "status": "processing",
        "total": len(contact_list),
        "done": 0,
        "current": None,
        "files": [],
        "engine": "elevenlabs",
    }

    background_tasks.add_task(
        run_composite_elevenlabs,
        job_id,
        face_path,
        ref_audio_path,
        contact_list,
        skip_seconds,
        scroll_start_seconds,
        gif_start_seconds,
        gif_end_seconds,
    )
    return {"jobId": job_id}


def _tag_video(video_path: str, lead_name: str) -> None:
    temp = video_path + ".tagged.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", video_path,
            "-c", "copy",
            "-metadata", f"title=Video for {lead_name}",
            "-metadata", "artist=Tkrupt",
            "-metadata", f"comment=Personalized video message for {lead_name}",
            temp,
        ],
        check=True,
        capture_output=True,
    )
    os.replace(temp, video_path)


def _overlay_face_on_scroll(scroll_path: str, face_path: str, output_path: str, scroll_start_seconds: float = 0.0):
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-stream_loop", "-1", "-i", scroll_path,
            "-i", face_path,
            "-filter_complex",
            (
                f"[0:v]trim=start={scroll_start_seconds},setpts=PTS-STARTPTS[scroll];"
                "[1:v]scale=200:200,format=rgba,"
                "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                "a='if(lt(hypot(X-100,Y-100),100),255,0)'[face];"
                "[scroll][face]overlay=20:main_h-220[vout]"
            ),
            "-map", "[vout]",
            "-map", "1:a?",
            "-c:v", "libx264",
            "-c:a", "aac",
            "-shortest",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


def _composite_with_voice(
    scroll_path: str,
    face_path: str,
    hey_wav: str,
    skip_seconds: float,
    scroll_start_seconds: float,
    output_path: str,
):
    hey_end = max(float(skip_seconds), 0.1)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-stream_loop", "-1", "-i", scroll_path,   # 0: scroll bg (looped)
            "-i", face_path,                            # 1: face recording
            "-i", hey_wav,                              # 2: cloned "Hey [Name]"
            "-filter_complex",
            (
                f"[0:v]trim=start={scroll_start_seconds},setpts=PTS-STARTPTS[scroll];"
                "[1:v]scale=200:200,format=rgba,"
                "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                "a='if(lt(hypot(X-100,Y-100),100),255,0)'[face];"
                "[scroll][face]overlay=20:main_h-220[vout];"
                f"[2:a]apad,atrim=end={hey_end},asetpts=PTS-STARTPTS,aresample=44100[a_hey];"
                f"[1:a]atrim=start={skip_seconds},asetpts=PTS-STARTPTS,aresample=44100[a_recorded];"
                "[a_hey][a_recorded]concat=n=2:v=0:a=1[aout]"
            ),
            "-map", "[vout]",
            "-map", "[aout]",
            "-c:v", "libx264",
            "-c:a", "aac",
            "-shortest",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


async def run_composite(
    job_id: str,
    face_path: str,
    ref_audio_path: str | None,
    contacts: list[dict],
    skip_seconds: float,
    scroll_start_seconds: float,
    gif_start_seconds: float,
    gif_end_seconds: float,
):
    for contact in contacts:
        name = contact["name"]
        scroll_fn = contact["scroll_filename"]
        composite_jobs[job_id]["current"] = name

        scroll_path = os.path.join(BACKEND_ROOT, "outputs", scroll_fn)

        if not os.path.exists(scroll_path):
            composite_jobs[job_id]["files"].append({"name": name, "error": "scroll video not found"})
            composite_jobs[job_id]["done"] += 1
            continue

        safe = name.lower().replace(" ", "-")
        out_fn = f"{job_id}_{safe}_sendspark.mp4"
        out_path = f"outputs/{out_fn}"

        try:
            if ref_audio_path and model:
                # Clone voice → "Hey [Name]" then composite everything
                wav, sr = await asyncio.to_thread(_generate_one, f"Hey {name}", ref_audio_path)
                hey_path = f"temp/{job_id}_{safe}_hey.wav"
                await asyncio.to_thread(torchaudio.save, hey_path, wav, sr)
                await asyncio.to_thread(
                    _composite_with_voice,
                    scroll_path, face_path, hey_path, skip_seconds, scroll_start_seconds, out_path,
                )
            else:
                # Face overlay only, keep face recording audio
                await asyncio.to_thread(
                    _overlay_face_on_scroll, scroll_path, face_path, out_path, scroll_start_seconds
                )

            await asyncio.to_thread(_tag_video, out_path, name)

            entry: dict = {"name": name, "filename": out_fn}
            composite_jobs[job_id]["files"].append(entry)
            try:
                preview_data = await asyncio.to_thread(
                    _upload_lead_preview_assets,
                    out_path,
                    name,
                    gif_start_seconds,
                    gif_end_seconds,
                )
                composite_jobs[job_id]["files"][-1].update(preview_data)
            except Exception:
                composite_jobs[job_id]["files"][-1].update(
                    {
                        "lead_slug": _slugify(name),
                        "preview_id": str(uuid.uuid4()),
                        "preview_url": None,
                        "vercel_preview_url": None,
                        "supabase_preview_url": None,
                        "image_preview_html_url": None,
                        "gif_preview_html_url": None,
                        "video_public_url": None,
                        "thumbnail_public_url": None,
                        "gif_public_url": None,
                        "email_gif_url": None,
                        "email_html_snippet": None,
                    }
                )
            if not composite_jobs[job_id]["files"][-1].get("video_public_url"):
                try:
                    object_key = _supabase_object_key(out_fn, "sendspark")
                    public_url = await asyncio.to_thread(_upload_file_to_supabase, out_path, object_key)
                    composite_jobs[job_id]["files"][-1]["video_public_url"] = public_url
                except Exception:
                    composite_jobs[job_id]["files"][-1]["video_public_url"] = None
            composite_jobs[job_id]["files"][-1]["public_url"] = (
                composite_jobs[job_id]["files"][-1].get("preview_url")
                or composite_jobs[job_id]["files"][-1].get("video_public_url")
            )
            _last = composite_jobs[job_id]["files"][-1]
            _last["email_html_snippet"] = _compose_email_html_snippet(
                _last.get("video_public_url"),
                _last.get("email_gif_url") or _last.get("gif_public_url"),
            )
        except Exception as e:
            composite_jobs[job_id]["files"].append({"name": name, "error": str(e)})

        composite_jobs[job_id]["done"] += 1

    composite_jobs[job_id]["status"] = "done"
    composite_jobs[job_id]["current"] = None


async def run_composite_elevenlabs(
    job_id: str,
    face_path: str,
    ref_audio_path: str,
    contacts: list[dict],
    skip_seconds: float,
    scroll_start_seconds: float,
    gif_start_seconds: float,
    gif_end_seconds: float,
):
    voice_id: str | None = None
    try:
        voice_id = await asyncio.to_thread(
            _elevenlabs_create_ivc_voice,
            ref_audio_path,
            f"sendspark-{job_id}",
        )

        for contact in contacts:
            name = contact["name"]
            scroll_fn = contact["scroll_filename"]
            composite_jobs[job_id]["current"] = name
            scroll_path = os.path.join(BACKEND_ROOT, "outputs", scroll_fn)

            if not os.path.exists(scroll_path):
                composite_jobs[job_id]["files"].append({"name": name, "error": "scroll video not found"})
                composite_jobs[job_id]["done"] += 1
                continue

            safe = name.lower().replace(" ", "-")
            out_fn = f"{job_id}_{safe}_sendspark.mp4"
            out_path = f"outputs/{out_fn}"
            hey_path = f"temp/{job_id}_{safe}_hey.mp3"

            try:
                await asyncio.to_thread(_elevenlabs_tts_to_file, voice_id, f"Hey {name}", hey_path)
                await asyncio.to_thread(
                    _composite_with_voice,
                    scroll_path,
                    face_path,
                    hey_path,
                    skip_seconds,
                    scroll_start_seconds,
                    out_path,
                )
                await asyncio.to_thread(_tag_video, out_path, name)

                entry: dict = {"name": name, "filename": out_fn}
                composite_jobs[job_id]["files"].append(entry)
                try:
                    preview_data = await asyncio.to_thread(
                        _upload_lead_preview_assets,
                        out_path,
                        name,
                        gif_start_seconds,
                        gif_end_seconds,
                    )
                    composite_jobs[job_id]["files"][-1].update(preview_data)
                except Exception:
                    composite_jobs[job_id]["files"][-1].update(
                        {
                            "lead_slug": _slugify(name),
                            "preview_id": str(uuid.uuid4()),
                            "preview_url": None,
                            "vercel_preview_url": None,
                            "supabase_preview_url": None,
                            "image_preview_html_url": None,
                            "gif_preview_html_url": None,
                            "video_public_url": None,
                            "thumbnail_public_url": None,
                            "gif_public_url": None,
                            "email_gif_url": None,
                            "email_html_snippet": None,
                        }
                    )
                if not composite_jobs[job_id]["files"][-1].get("video_public_url"):
                    try:
                        object_key = _supabase_object_key(out_fn, "sendspark-elevenlabs")
                        public_url = await asyncio.to_thread(_upload_file_to_supabase, out_path, object_key)
                        composite_jobs[job_id]["files"][-1]["video_public_url"] = public_url
                    except Exception:
                        composite_jobs[job_id]["files"][-1]["video_public_url"] = None
                composite_jobs[job_id]["files"][-1]["public_url"] = (
                    composite_jobs[job_id]["files"][-1].get("preview_url")
                    or composite_jobs[job_id]["files"][-1].get("video_public_url")
                )
                _last_el = composite_jobs[job_id]["files"][-1]
                _last_el["email_html_snippet"] = _compose_email_html_snippet(
                    _last_el.get("video_public_url"),
                    _last_el.get("email_gif_url") or _last_el.get("gif_public_url"),
                )
            except Exception as exc:
                composite_jobs[job_id]["files"].append({"name": name, "error": str(exc)})

            composite_jobs[job_id]["done"] += 1
    except Exception as exc:
        composite_jobs[job_id]["files"].append({"name": "job", "error": str(exc)})
    finally:
        if voice_id:
            try:
                await asyncio.to_thread(_elevenlabs_delete_voice, voice_id)
            except Exception:
                pass
        composite_jobs[job_id]["status"] = "done"
        composite_jobs[job_id]["current"] = None


@app.get("/composite-status/{job_id}")
def composite_status(job_id: str):
    job = composite_jobs.get(job_id)
    if not job:
        return JSONResponse({"status": "not_found"}, status_code=404)
    return job


# ── Download ──────────────────────────────────────────────────────────────────

@app.get("/download/{filename}")
def download_file(filename: str):
    filename = os.path.basename(filename)
    path = f"outputs/{filename}"
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    media_type = "video/mp4" if filename.endswith(".mp4") else "audio/wav"
    return FileResponse(path, media_type=media_type, filename=filename)


@app.get("/download-all/{job_id}")
def download_all(job_id: str):
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        return JSONResponse({"error": "job not ready"}, status_code=404)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in job["files"]:
            fn = entry.get("video_filename") or entry.get("filename")
            if fn:
                path = f"outputs/{fn}"
                if os.path.exists(path):
                    zf.write(path, fn)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="voices_{job_id}.zip"'},
    )


@app.get("/composite-download-all/{job_id}")
def composite_download_all(job_id: str):
    job = composite_jobs.get(job_id)
    if not job or job["status"] != "done":
        return JSONResponse({"error": "job not ready"}, status_code=404)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in job["files"]:
            fn = entry.get("filename")
            if fn:
                path = f"outputs/{fn}"
                if os.path.exists(path):
                    zf.write(path, fn)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="sendspark_{job_id}.zip"'},
    )


# ── Audio helpers (used by voice cloner page) ─────────────────────────────────

def _get_duration(path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def _get_video_size(path: str) -> tuple[str, str]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True, check=True,
    )
    w, h = result.stdout.strip().split("x")
    return w, h


def _concat_audio(hey_wav: str, ref_audio: str, output_wav: str, skip_seconds: float = 3.0):
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", hey_wav,
            "-i", ref_audio,
            "-filter_complex",
            (
                f"[0:a]aresample=44100[a0];"
                f"[1:a]atrim=start={skip_seconds},asetpts=PTS-STARTPTS,aresample=44100[a1];"
                f"[a0][a1]concat=n=2:v=0:a=1[aout]"
            ),
            "-map", "[aout]",
            output_wav,
        ],
        check=True,
        capture_output=True,
    )


def _merge_hey_with_video(hey_wav: str, original_video: str, output_mp4: str):
    hey_dur = _get_duration(hey_wav)
    w, h = _get_video_size(original_video)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", hey_wav,
            "-i", original_video,
            "-filter_complex",
            (
                f"color=black:s={w}x{h}:r=30:d={hey_dur}[vblack];"
                f"[vblack][1:v]concat=n=2:v=1:a=0[vout];"
                f"[0:a]aresample=44100[a0];"
                f"[1:a]aresample=44100[a1];"
                f"[a0][a1]concat=n=2:v=0:a=1[aout]"
            ),
            "-map", "[vout]",
            "-map", "[aout]",
            "-c:v", "libx264",
            "-c:a", "aac",
            output_mp4,
        ],
        check=True,
        capture_output=True,
    )
