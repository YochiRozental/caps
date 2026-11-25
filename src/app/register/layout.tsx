import type { Metadata } from "next";

export const metadata: Metadata = { title: "הרשמה", alternates: { canonical: "/register" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
