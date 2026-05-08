import asyncio
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
from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from supabase import Client, create_client

app = FastAPI()

# CORS configuration for dev and production
allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
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
SCROLL_STATUS_STALE_SECONDS = max(60, int(os.getenv("SCROLL_STATUS_STALE_SECONDS", "180")))
ENABLE_CHATTERBOX = os.getenv("ENABLE_CHATTERBOX", "false").strip().lower() not in ("0", "false", "no", "off")

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
    content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    with open(local_path, "rb") as f:
        supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
            path=object_key,
            file=f,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    return supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(object_key)


def _safe_slug(value: str) -> str:
    normalized = value.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    return normalized or "lead"


def _generate_thumbnail(video_path: str, output_path: str, target_seconds: float | None = None) -> None:
    if target_seconds is None:
        duration = _get_duration(video_path)
        if duration <= 0:
            target_seconds = 0.5
        else:
            target_seconds = min(max(duration * 0.5, 1.0), max(duration - 0.1, 0.5))
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(target_seconds),
            "-i",
            video_path,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


def _preview_object_key(lead_slug: str, preview_id: str, filename: str) -> str:
    return _supabase_object_key(filename, f"previews/{lead_slug}/{preview_id}")


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
        print("Chatterbox disabled via ENABLE_CHATTERBOX env var; skipping model load.")
        model = None
        return

    try:
        import torch
        from chatterbox.tts import ChatterboxTTS
    except ImportError as exc:
        print(f"Chatterbox dependencies not installed: {exc}")
        model = None
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Chatterbox on {device}…")
    model = await asyncio.to_thread(ChatterboxTTS.from_pretrained, device)
    print("Model ready.")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "chatterbox_enabled": ENABLE_CHATTERBOX,
    }


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


@app.get("/preview/metadata/{lead}/{preview_id}")
def preview_metadata(lead: str, preview_id: str):
    if not supabase_client or not SUPABASE_STORAGE_BUCKET:
        return JSONResponse({"error": "Supabase not configured"}, status_code=503)

    lead_slug = _safe_slug(lead)
    video_key = _preview_object_key(lead_slug, preview_id, "video.mp4")
    thumbnail_key = _preview_object_key(lead_slug, preview_id, "thumbnail.png")

    display_name = lead_slug.replace("-", " ").title()
    return {
        "lead": lead,
        "preview_id": preview_id,
        "preview_path": f"/preview/{lead_slug}/{preview_id}",
        "video_url": supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(video_key),
        "thumbnail_url": supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(thumbnail_key),
        "title": f"{display_name} — Personalized Outreach Video",
        "description": f"Watch a personalized outreach video created for {display_name}.",
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
        return JSONResponse({"error": "Chatterbox model is disabled or not loaded"}, status_code=503)

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
            import torchaudio
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
    job_file = os.path.join(jobs_dir, f"{job_id}.json")
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump({"status": "queued", "created_at": time.time()}, f)

    log_file = os.path.join(BACKEND_ROOT, ".jobs", f"{job_id}.log")
    try:
        with open(log_file, "wb") as lf:
            proc = subprocess.Popen(
                ["node", "scripts/record-paged.js", url, job_id],
                cwd=BACKEND_ROOT,
                stdout=lf,
                stderr=lf,
            )
        # Give the process 3 seconds to crash at startup (module load errors etc.)
        await asyncio.sleep(3)
        if proc.poll() is not None and proc.returncode != 0:
            # Process already died — read the log and mark job as error
            try:
                with open(log_file, "r", encoding="utf-8", errors="replace") as lf:
                    stderr_text = lf.read()[-2000:]
            except Exception:
                stderr_text = "unknown error"
            # Only overwrite if still queued (node script may have updated it)
            with open(job_file, "r", encoding="utf-8") as f:
                current = json.load(f)
            if current.get("status") == "queued":
                with open(job_file, "w", encoding="utf-8") as f:
                    json.dump({"status": "error", "error": f"node crashed: {stderr_text}", "created_at": time.time()}, f)
    except Exception as exc:
        error_data = {"status": "error", "error": str(exc), "created_at": time.time()}
        with open(job_file, "w", encoding="utf-8") as f:
            json.dump(error_data, f)
        return JSONResponse({"error": "Failed to launch scroll job"}, status_code=500)

    return {"jobId": job_id}


@app.get("/scroll-status/{job_id}")
def scroll_status(job_id: str):
    job_file = os.path.join(BACKEND_ROOT, ".jobs", f"{job_id}.json")
    if not os.path.exists(job_file):
        return JSONResponse({"status": "not_found"}, status_code=404)
    with open(job_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    status = data.get("status")
    if status in {"recording", "queued"}:
        try:
            age_seconds = int(time.time() - os.path.getmtime(job_file))
            if age_seconds > SCROLL_STATUS_STALE_SECONDS:
                data = {
                    "status": "error",
                    "error": f"stale scroll job exceeded {SCROLL_STATUS_STALE_SECONDS}s",
                }
                with open(job_file, "w", encoding="utf-8") as wf:
                    json.dump(data, wf)
        except Exception:
            pass

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
        run_composite, job_id, face_path, ref_audio_path, contact_list, skip_seconds, scroll_start_seconds
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
    )
    return {"jobId": job_id}


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

        safe = _safe_slug(name)
        out_fn = f"{job_id}_{safe}_sendspark.mp4"
        out_path = f"outputs/{out_fn}"

        try:
            if ref_audio_path and model:
                # Clone voice → "Hey [Name]" then composite everything
                import torchaudio
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

            preview_id = f"{job_id}_{safe}"
            preview_path = f"/preview/{safe}/{preview_id}"
            composite_jobs[job_id]["files"].append(
                {"name": name, "filename": out_fn, "preview_id": preview_id, "preview_path": preview_path}
            )

            try:
                preview_video_key = _preview_object_key(safe, preview_id, "video.mp4")
                public_url = await asyncio.to_thread(_upload_file_to_supabase, out_path, preview_video_key)
                if public_url:
                    composite_jobs[job_id]["files"][-1]["public_url"] = public_url
            except Exception:
                composite_jobs[job_id]["files"][-1]["public_url"] = None

            try:
                thumbnail_path = f"outputs/{preview_id}_thumbnail.png"
                await asyncio.to_thread(_generate_thumbnail, out_path, thumbnail_path)
                thumbnail_key = _preview_object_key(safe, preview_id, "thumbnail.png")
                thumbnail_url = await asyncio.to_thread(_upload_file_to_supabase, thumbnail_path, thumbnail_key)
                composite_jobs[job_id]["files"][-1]["thumbnail_url"] = thumbnail_url
            except Exception:
                composite_jobs[job_id]["files"][-1]["thumbnail_url"] = None
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

            safe = _safe_slug(name)
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

                preview_id = f"{job_id}_{safe}"
                preview_path = f"/preview/{safe}/{preview_id}"
                composite_jobs[job_id]["files"].append(
                    {"name": name, "filename": out_fn, "preview_id": preview_id, "preview_path": preview_path}
                )
                try:
                    preview_video_key = _preview_object_key(safe, preview_id, "video.mp4")
                    public_url = await asyncio.to_thread(_upload_file_to_supabase, out_path, preview_video_key)
                    if public_url:
                        composite_jobs[job_id]["files"][-1]["public_url"] = public_url
                except Exception:
                    composite_jobs[job_id]["files"][-1]["public_url"] = None

                try:
                    thumbnail_path = f"outputs/{preview_id}_thumbnail.png"
                    await asyncio.to_thread(_generate_thumbnail, out_path, thumbnail_path)
                    thumbnail_key = _preview_object_key(safe, preview_id, "thumbnail.png")
                    thumbnail_url = await asyncio.to_thread(_upload_file_to_supabase, thumbnail_path, thumbnail_key)
                    composite_jobs[job_id]["files"][-1]["thumbnail_url"] = thumbnail_url
                except Exception:
                    composite_jobs[job_id]["files"][-1]["thumbnail_url"] = None
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
