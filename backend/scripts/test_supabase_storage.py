import os
import sys
import uuid

from supabase import create_client


def load_env_file() -> None:
    backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    env_path = os.path.join(backend_dir, ".env")
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


def main() -> int:
    load_env_file()
    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "Videos").strip()
    prefix = os.getenv("SUPABASE_PATH_PREFIX", "sendspark").strip().strip("/")

    missing = [name for name, val in [
        ("SUPABASE_URL", url),
        ("SUPABASE_SERVICE_ROLE_KEY", key),
        ("SUPABASE_STORAGE_BUCKET", bucket),
    ] if not val]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}")
        return 1

    client = create_client(url, key)
    object_key = f"{prefix}/tests/{uuid.uuid4()}.txt" if prefix else f"tests/{uuid.uuid4()}.txt"
    payload = b"supabase storage test from backend script"

    try:
        client.storage.from_(bucket).upload(
            path=object_key,
            file=payload,
            file_options={"content-type": "text/plain", "upsert": "true"},
        )
        public_url = client.storage.from_(bucket).get_public_url(object_key)
        print("Upload successful.")
        print(f"Bucket: {bucket}")
        print(f"Object key: {object_key}")
        print(f"Public URL: {public_url}")
        return 0
    except Exception as exc:
        print(f"Upload failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
