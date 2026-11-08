import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { I18nProvider } from "@/lib/i18n";
import { readLangCookie, LANG_STORAGE_KEY } from "@/lib/i18n/detect";
import { ru } from "@/lib/i18n/ru";
import { en } from "@/lib/i18n/en";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Язык для серверного рендера: cookie ndrh.lang (её выставляет клиентский
// i18n-слой при определении/переключении языка). Без cookie — русский,
// основной язык проекта.
async function langFromCookies() {
  const store = await cookies();
  return readLangCookie(store.get(LANG_STORAGE_KEY)?.value) ?? "ru";
}

export async function generateMetadata(): Promise<Metadata> {
  const dict = (await langFromCookies()) === "en" ? en : ru;
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "48x48" },
        { url: "/logo.svg", type: "image/svg+xml" },
      ],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const lang = await langFromCookies();
  return (
    // lang выставляется по cookie — совпадает с интерфейсом пользователя;
    // клиентский I18nProvider обновляет атрибут при переключении на лету
    <html lang={lang} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <I18nProvider>{children}</I18nProvider>
        <Toaster />
      </body>
    </html>
  );
}
