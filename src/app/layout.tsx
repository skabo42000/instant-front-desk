import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Instant Front Desk — prototype",
  description: "Local prototype scaffold for a website-based assistant.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
