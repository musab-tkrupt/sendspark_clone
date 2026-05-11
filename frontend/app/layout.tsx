import type { Metadata } from "next";
import "./globals.css";
import { ApiBaseProvider } from "./components/ApiBaseProvider";
import Navbar from "./components/Navbar";

export const metadata: Metadata = {
  title: "VoiceKit",
  description: "Voice cloning and personalised video outreach",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ApiBaseProvider>
          <Navbar />
          {children}
        </ApiBaseProvider>
      </body>
    </html>
  );
}
