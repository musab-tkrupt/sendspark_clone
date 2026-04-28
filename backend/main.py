import asyncio
import json
import os
import subprocess
import uuid
import zipfile
from io import BytesIO

import torch
import torchaudio
from chatterbox.tts import ChatterboxTTS
from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

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

SS_CLONE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))

os.makedirs("temp", exist_ok=True)
os.makedirs("outputs", exist_ok=True)


# ── Startup ──────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def load_model():
    global model
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Chatterbox on {device}…")
    model = await asyncio.to_thread(ChatterboxTTS.from_pretrained, device)
    print("Model ready.")


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None}


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
    jobs_dir = os.path.join(SS_CLONE_ROOT, ".jobs")
    os.makedirs(jobs_dir, exist_ok=True)
    with open(os.path.join(jobs_dir, f"{job_id}.json"), "w") as f:
        json.dump({"status": "recording"}, f)

    subprocess.Popen(
        ["node", "scripts/record.js", url, job_id],
        cwd=SS_CLONE_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"jobId": job_id}


@app.get("/scroll-status/{job_id}")
def scroll_status(job_id: str):
    job_file = os.path.join(SS_CLONE_ROOT, ".jobs", f"{job_id}.json")
    if not os.path.exists(job_file):
        return JSONResponse({"status": "not_found"}, status_code=404)
    with open(job_file) as f:
        return json.load(f)


@app.get("/scroll-video/{filename}")
def scroll_video(filename: str):
    filename = os.path.basename(filename)
    path = os.path.join(SS_CLONE_ROOT, "outputs", filename)
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
                f"[2:a]atrim=end={hey_end},asetpts=PTS-STARTPTS,aresample=44100[a_hey];"
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

        scroll_path = os.path.join(SS_CLONE_ROOT, "outputs", scroll_fn)

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

            composite_jobs[job_id]["files"].append({"name": name, "filename": out_fn})
        except Exception as e:
            composite_jobs[job_id]["files"].append({"name": name, "error": str(e)})

        composite_jobs[job_id]["done"] += 1

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
