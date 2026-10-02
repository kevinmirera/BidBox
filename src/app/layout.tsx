import "./globals.css";
export const metadata = { title: "Bid Box", description: "Procurement analysis workspace" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
