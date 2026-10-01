export const metadata = { title: "Bid Box", description: "Agentic procurement analysis. No award decisions." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0f1115", color: "#e6e8ee" }}>{children}</body></html>);
}
