import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bros and Subs — Backend",
  description: "API y webhook receiver del panel admin de Bros and Subs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
