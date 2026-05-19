import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent Jobs",
  description: "Multi-agent job platform",
};

const NAV_ITEMS = [
  { href: "/jobs", label: "Jobs" },
  { href: "/kanban", label: "Kanban" },
  { href: "/chat", label: "Chat" },
  { href: "/settings/keys", label: "Settings" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ ["--font-sans" as string]: "var(--font-geist-sans)" }}
    >
      <body className="min-h-full">
        <div className="flex min-h-screen">
          <aside className="w-[240px] shrink-0 border-r bg-sidebar text-sidebar-foreground">
            <div className="flex h-14 items-center gap-2 border-b px-4">
              <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
                AJ
              </div>
              <span className="font-heading text-sm font-semibold">
                Agent Jobs
              </span>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="flex-1 overflow-x-hidden p-8">{children}</main>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
