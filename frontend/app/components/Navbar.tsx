"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Voice Cloner" },
  { href: "/sendspark", label: "SendSpark" },
  { href: "/steps1", label: "Steps" },
  { href: "/dependency-check", label: "Dependency Check" },
];

export default function Navbar() {
  const pathname = usePathname();
  return (
    <nav className="w-full border-b border-gray-800 bg-black/60 backdrop-blur sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <span className="font-bold text-lg tracking-tight text-white">VoiceKit</span>
        <div className="flex items-center gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                pathname === l.href
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
