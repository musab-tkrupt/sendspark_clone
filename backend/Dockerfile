FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Node dependencies used by backend/scripts/record-paged.js
COPY package.json package-lock.json ./
RUN npm install

# Install Python dependencies (force CPU torch wheels first)
COPY voice/backend/requirements.txt /app/voice/backend/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchaudio \
    && pip install --no-cache-dir -r /app/voice/backend/requirements.txt

COPY voice/backend /app/voice/backend

WORKDIR /app/voice/backend

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
