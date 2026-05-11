"use client";

import { useRef, useState } from "react";

export default function VideoPlayer({
  src,
  poster,
}: {
  src: string;
  poster: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  function handleClick() {
    if (!videoRef.current) return;
    videoRef.current.play();
    setPlaying(true);
  }

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden bg-black shadow-2xl cursor-pointer group"
      onClick={handleClick}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        poster={poster}
        src={src}
        className="w-full block"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition-colors pointer-events-none">
          <div className="w-20 h-20 rounded-full bg-white/15 backdrop-blur border-2 border-white/40 flex items-center justify-center">
            <svg className="w-8 h-8 fill-white ml-1" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
