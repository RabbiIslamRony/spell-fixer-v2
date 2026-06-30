import "./globals.css";
import { SiteHeader } from "./components/SiteHeader";

export const metadata = {
  title: "Grammar Assistant - Chrome Writing Assistant",
  description:
    "Grammar Assistant is a Chrome extension with fast inline grammar suggestions powered by a hosted or self-hosted Cloudflare Worker.",
  icons: {
    icon: "/assets/logo-48.png"
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
