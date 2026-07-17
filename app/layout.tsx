import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "Atmospheric Transport Explorer",
  description: "Trace the modeled origins of air arriving at any location, entirely in your browser.",
  openGraph: {
    title: "Atmospheric Transport Explorer",
    description: "Trace the modeled origins of the air arriving here.",
    type: "website",
    images: [{ url: "/og.png", width: 1728, height: 905, alt: "Atmospheric trajectories converging on San Francisco" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atmospheric Transport Explorer",
    description: "Trace the modeled origins of the air arriving here.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
