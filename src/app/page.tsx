"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Any = any;
const VIEWS = [
  { id: "overview", label: "Overview", d: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" },
  { id: "bids", label: "Bids", d: "M4 6h16M4 12h16M4 18h10" },
  { id: "calibration", label: "Calibration", d: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3 2" },
  { id: "search", label: "Search", d: "M11 4a7 7 0 105 12l4 4M11 7a4 4 0 100 8" },
  { id: "findings", label: "Findings", d: "M5 21V4m0 0h11l-2 4 2 4H5" },
  { id: "activity", label: "Activity", d: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "review", label: "Committee review", d: "M7 3h8l4 4v14H7zM9 13l2 2 4-4" },
] as const;

const Icon = ({ d }: { d: string }) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const tone = (s: string) => (/VERIFIED|CONFIRMED|SUCCESS|COMPLETE|CALIBRATED|INTACT|APPROVED|ANALYSED/.test(s) ? "ok" : /MISSING|ERROR|CONTRADICT|FAIL|REJECT|BROKEN/.test(s) ? "bad" : /INVESTIGATE|FLAG|PAUSED|PROVISIONAL|RESOLVED|PENDING|UNVERIFIED|REVIEW|STANDS|INCOMPLETE/.test(s) ? "warn" : /CALIBRATION|SEQUENTIAL/.test(s) ? "brand" : "mute");
const Chip = ({ s, label }: { s: string; label?: string }) => <span className={`chip ${tone(s)}`}>{label ?? s.replace(/_/g, " ")}</span>;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: any) => (typeof x === "number" ? (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(x >= 1e5 ? 0 : 1)}k` : String(Math.round(x))) : "-");
const PALETTE = ["#dfe8ff", "#e9e1ff", "#dcf5ea", "#fff0d6", "#fde3e6", "#dff3f8"];
const initials = (s: string) => (s || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const delay = (i: number): React.CSSProperties => ({ animationDelay: `${i * 70}ms` });

function Ring({ value, size = 120, label, sub }: { value: number; size?: number; label: string; sub?: string }) {
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  return (<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e8ecf8" strokeWidth="10" />
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#g)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${c * Math.min(1, value)} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dasharray .9s cubic-bezier(.2,.8,.2,1)" }} />
    <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stopColor="#3b6cf6" /><stop offset="1" stopColor="#8fb0ff" /></linearGradient></defs>
    <text x="50%" y="48%" textAnchor="middle" fontSize="22" fontWeight="750" fill="#16203a">{label}</text>
    {sub && <text x="50%" y="63%" textAnchor="middle" fontSize="11" fill="#6b7694">{sub}</text>}
  </svg>);
}

function PriceChart({ bids, cal, flagged }: { bids: Any[]; cal: Any; flagged: Set<string> }) {
  const W = 700, H = 240, L = 46, R = 8, T = 16, B = 28;
  const med = cal?.reference?.price_usd?.median as number | undefined;
  const vals = bids.map((b) => b.metrics?.price_usd).filter((v: any) => typeof v === "number") as number[];
  if (!vals.length) return <div className="hint" style={{ padding: 30 }}>Prices appear here once bids are processed.</div>;
  const yMax = med ? med * 1.8 : Math.max(...vals);
  const y = (v: number) => T + (H - T - B) * (1 - Math.min(v, yMax) / yMax);
  const bw = (W - L - R) / bids.length;
  return (<svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
    {[0, .25, .5, .75, 1].map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(yMax * t)} y2={y(yMax * t)} stroke="#e8ecf8" /><text x={L - 6} y={y(yMax * t) + 4} fontSize="10" textAnchor="end" fill="#6b7694">{money(yMax * t)}</text></g>)}
    {med && <rect x={L} width={W - L - R} y={y(med * 1.25)} height={y(med * 0.75) - y(med * 1.25)} fill="#3b6cf6" opacity=".08" />}
    {med && <line x1={L} x2={W - R} y1={y(med)} y2={y(med)} stroke="#3b6cf6" strokeDasharray="5 4" />}
    {bids.map((b, i) => {
      const v = b.metrics?.price_usd; const x = L + i * bw + 3;
      if (typeof v !== "number") return <text key={b.ref} x={x + bw / 2 - 3} y={H - B - 4} fontSize="9" textAnchor="middle" fill="#9aa3bd">n/a</text>;
      const clipped = v > yMax; const col = flagged.has(b.ref) ? "#e8930c" : b.role === "CALIBRATION" ? "#9db8ff" : "#3b6cf6";
      return (<g key={b.ref}><rect className="bar-grow" style={{ animationDelay: `${i * 35}ms` }} x={x} width={Math.max(4, bw - 6)} y={y(v)} height={H - B - y(v)} rx="4" fill={col} />
        {clipped && <text x={x + (bw - 6) / 2} y={y(v) - 3} fontSize="9" textAnchor="middle" fill="#e8930c">▲ {money(v)}</text>}
        <text x={x + (bw - 6) / 2} y={H - 10} fontSize="9" textAnchor="middle" fill="#6b7694">{b.ref.slice(-2)}</text></g>);
    })}
  </svg>);
}

export default function Page() {
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("overview");
  const [token, setToken] = useState("");
  const [d, setD] = useState<Any>(null);
  const [state, setState] = useState<"loading" | "ok" | "empty" | "auth" | "error">("loading");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<Any>(null);
  const [models, setModels] = useState<Any[]>([]);
  const [model, setModel] = useState("claude");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [chat, setChat] = useState<Any[]>([]);
  const [searching, setSearching] = useState(false);
  const [sr, setSr] = useState<Any>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const hdr = useCallback((): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {}), [token]);
  const notify = (t: Any) => { setToast(t); setTimeout(() => setToast(null), 7000); };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard", { headers: hdr() }); const j = await r.json();
      if (r.status === 401 || r.status === 503) { setState("auth"); setErr(j.error || ""); return; }
      if (!r.ok) { setErr(j.error || "error"); setState(/tender not found/i.test(j.error || "") ? "empty" : "error"); return; }
      setErr(""); setD(j); setState("ok");
    } catch (e: any) { setErr(e.message); setState("error"); }
  }, [hdr]);
  const loadModels = useCallback(async () => {
    const r = await fetch("/api/models", { headers: hdr() }); if (!r.ok) return; const j = await r.json(); setModels(j.models);
    setModel((m) => (j.models.find((x: Any) => x.id === m && x.configured) ? m : j.models.find((x: Any) => x.configured && x.id !== "direct" && x.id !== "scripted")?.id ?? "direct"));
  }, [hdr]);

  useEffect(() => { try { setToken(sessionStorage.getItem("bb_token") || ""); } catch {} }, []);
  useEffect(() => { load(); loadModels(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load, loadModels]);
  useEffect(() => { feedRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }); }, [chat, searching]);

  const post = async (url: string, body?: Any) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...hdr() }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
  const setup = async () => { setBusy("setup"); const { ok, j } = await post("/api/setup"); setBusy(""); notify(ok ? { ok: true, text: `Data loaded: ${j.bids ?? 20} bids${j.open_data?.seeded ? `, ${j.open_data.procurements} sample open-contracting records` : ""}.` } : { ok: false, text: j.error || "Setup failed" }); load(); };
  const testMcp = async () => { setBusy("mcp"); const { ok, j } = await post("/api/mcp-check"); setBusy(""); notify(ok ? { ok: true, text: `MCP connected in ${j.ms} ms. ${j.tools.length} tools discovered: ${j.tools.join(", ")}.` } : { ok: false, text: `MCP check failed: ${j.error}${j.hint ? " - " + j.hint : ""}` }); };
  const run = async () => { setBusy("run"); const { ok, j } = await post("/api/runs", { tender_id: "TND-2026-014", batch_size: 25, provider: model === "direct" ? undefined : model }); setBusy(""); notify(ok ? { ok: true, text: `Run ${j.status.toLowerCase()}: ${j.processed}/${j.total} bids processed.` } : { ok: false, text: j.error || "Run failed" }); load(); };
  const approve = async (status: "APPROVED" | "REJECTED") => { const approver = prompt("Your name (recorded as the human approver):"); if (!approver) return; const { ok, j } = await post("/api/approvals", { evaluation_id: d.evaluation.id, status, approver, note: "via dashboard" }); if (!ok) notify({ ok: false, text: j.error }); load(); };

  const ask = async (text: string) => {
    if (!text.trim()) return; setQ(""); setSearching(true);
    setChat((c) => [...c, { role: "user", text }]);
    try {
      if (model === "direct") {
        const kw = text.replace(/\b(find|show|search|tenders?|procurements?|for|in|data|open)\b/gi, " ").replace(/\b(Kenya|Rwanda|Tanzania|Nigeria|Ghana|Zambia|Uganda|Liberia|South Africa)\b/gi, "").trim() || text;
        const code: Any = { kenya: "KE", rwanda: "RW", tanzania: "TZ", nigeria: "NG", ghana: "GH", zambia: "ZM", uganda: "UG", liberia: "LR", "south africa": "ZA" };
        const c = Object.keys(code).find((k) => text.toLowerCase().includes(k));
        const { ok, j } = await post("/api/search", { keyword: kw.slice(0, 60), ...(c ? { country: code[c] } : {}) });
        if (!ok) throw new Error(j.error); setSr(j); setChat((cc) => [...cc, { role: "ai", model: "Direct search", text: `${j.count} result(s) for "${j.keyword}" (${j.country}). ${j.standouts} stand out against the calibration reference.` }]);
      } else {
        const { ok, j } = await post("/api/assistant", { query: text, provider: model });
        if (!ok) throw new Error(j.error || "assistant failed"); if (j.results) setSr(j.results);
        setChat((cc) => [...cc, { role: "ai", model: j.model, text: j.answer || "(no answer)", events: j.events }]);
      }
    } catch (e: any) { setChat((cc) => [...cc, { role: "ai", error: true, text: e.message }]); }
    setSearching(false);
  };

  const bids: Any[] = d?.bids ?? []; const cal = d?.calibration; const findings: Any[] = d?.findings ?? [];
  const flagged = useMemo(() => new Set<string>(findings.filter((f) => /PRICE/.test(f.kind)).map((f) => f.bid)), [findings]);
  const processed = bids.filter((b) => b.status !== "RECEIVED").length;
  const needHuman = findings.filter((f) => ["EVIDENCE_MISSING", "CONTRADICTED", "OPEN"].includes(f.status)).length;
  const resolved = findings.filter((f) => f.status === "RESOLVED").length;
  const bidStatus = (b: Any) => { const fs = findings.filter((f) => f.bid === b.ref); return b.status === "RECEIVED" ? "QUEUED" : b.role === "CALIBRATION" && !fs.length ? "CALIBRATION" : fs.some((f) => f.status === "OPEN") ? "INVESTIGATE" : fs.length ? "REVIEW" : "ANALYSED"; };
  const events: Any[] = d?.run?.events ?? [];
  const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id;

  const Models = (<select className="tok" style={{ width: "auto" }} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
    {models.map((m) => <option key={m.id} value={m.id} disabled={!m.configured}>{m.label}{m.configured ? "" : ` - needs ${m.needs}`}</option>)}</select>);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections"><div className="logo">B</div>
        {VIEWS.map((v) => <button key={v.id} className={`nav ${view === v.id ? "on" : ""}`} data-tip={v.label} onClick={() => setView(v.id)} aria-label={v.label}><Icon d={v.d} /></button>)}</nav>
      <main className="main">
        <header className="top slide">
          <div><h1>Bid Box</h1><div className="sub">{d ? `${d.tender.ref} · ${d.tender.title}` : "Procurement analysis workspace"}</div></div>
          <div className="actions">
            <input className="tok" type="password" placeholder="Access token" value={token} onChange={(e) => { setToken(e.target.value); try { sessionStorage.setItem("bb_token", e.target.value); } catch {} }} />
            <button className="btn" onClick={testMcp} disabled={!!busy}>{busy === "mcp" ? "Testing…" : "Test MCP"}</button>
            <button className="btn" onClick={setup} disabled={!!busy}>{busy === "setup" ? "Loading…" : "Load data"}</button>
            {Models}
            <button className="btn primary" onClick={run} disabled={!!busy || state !== "ok" || model === "direct"}>{busy === "run" ? "Running…" : "Run analysis"}</button>
          </div>
        </header>

        {toast && <div className={`card toast slide-r`} style={{ borderLeft: `4px solid ${toast.ok ? "var(--ok)" : "var(--bad)"}` }}><div style={{ fontSize: 13 }}>{toast.text}</div></div>}

        {state === "loading" && <div className="card empty rise"><div className="hint live">Loading…</div></div>}
        {state === "auth" && <div className="card empty rise"><h2>Enter your access token</h2><div className="hint">Paste the ADMIN_API_TOKEN you set in Vercel into the box at the top right. {err}</div></div>}
        {state === "error" && <div className="card empty rise"><h2>Something went wrong</h2><div className="hint">{err}</div></div>}
        {state === "empty" && <div className="card empty rise"><h2>No data yet</h2><div className="hint">The database is connected but empty. Load the sample tender, 20 bids and sample open-contracting records.</div><button className="btn primary" onClick={setup} disabled={!!busy}>{busy === "setup" ? "Loading…" : "Load data"}</button></div>}

        {(state === "ok" || view === "search") && state !== "auth" && state !== "loading" && state !== "empty" && state !== "error" && d && (<div key={view}>
          {view === "overview" && (<>
            <div className="grid g4" style={{ marginBottom: 16 }}>
              {[{ l: "Bids processed", v: processed, of: bids.length, p: bids.length ? processed / bids.length : 0 }, { l: "Calibration bids", v: cal.ingested, of: cal.size, p: cal.size ? cal.ingested / cal.size : 0 }, { l: "Findings", v: findings.length, of: null, p: findings.length ? resolved / findings.length : 0, note: `${resolved} resolved` }, { l: "Evidence records", v: d.evidence.length, of: null, p: d.evidence.length ? d.evidence.filter((e: Any) => e.status === "VERIFIED").length / d.evidence.length : 0, note: "verified" }]
                .map((k, i) => (<div key={k.l} className="card kpi slide" style={delay(i)}><div className="label">{k.l}</div><div className="val">{k.v}{k.of != null && <small> / {k.of}</small>}</div><div className="bar"><i style={{ width: pct(k.p) }} /></div>{k.note && <div className="hint" style={{ marginTop: 6 }}>{pct(k.p)} {k.note}</div>}</div>))}
            </div>
            <div className="grid g-main">
              <div className="grid">
                <div className="card slide" style={delay(4)}><h3>Bid prices vs. calibration reference</h3><div className="hint">Shaded band = ±25% around the reference median. Light bars are the calibration set (first {cal.size} of {cal.total}); orange = price flagged.</div><PriceChart bids={bids} cal={cal} flagged={flagged} /></div>
                <div className="card slide" style={delay(5)}><h3>Bid stream</h3>
                  {bids.map((b, i) => { const fs = findings.filter((f) => f.bid === b.ref); const st = bidStatus(b); return (<div key={b.ref}>
                    <div className="row" onClick={() => setOpen(open === b.ref ? null : b.ref)} role="button">
                      <div className="avatar" style={{ background: PALETTE[i % PALETTE.length] }}>{initials(b.supplier)}</div>
                      <div className="grow"><div className="name">{b.supplier}</div><div className="hint">{b.ref} · {b.role === "CALIBRATION" ? "calibration set" : "sequential"}{b.metrics?.delivery_days ? ` · ${b.metrics.delivery_days} days` : ""}</div></div>
                      <div className="right"><div style={{ fontWeight: 650 }}>{b.metrics?.price_usd != null ? `$${money(b.metrics.price_usd)}` : "-"}</div><Chip s={st} /></div></div>
                    {open === b.ref && <div className="detail">{fs.length ? fs.map((f) => <div key={f.id} style={{ marginBottom: 6 }}><Chip s={f.status} /> <b>{f.kind.replace(/_/g, " ")}</b>: {f.description}</div>) : "No findings."}{b.missing?.length > 0 && <div className="hint" style={{ marginTop: 4 }}>Missing: {b.missing.join(" · ")}</div>}</div>}
                  </div>); })}
                </div>
              </div>
              <div className="grid">
                <div className="card slide-r" style={delay(4)}><h3>Insights</h3>
                  <div style={{ display: "grid", gap: 10, marginTop: 10, fontSize: 13 }}>
                    <div><span className="pill-dot" style={{ background: "var(--warn)" }} /> <b>{needHuman}</b> finding(s) need human review</div>
                    <div><span className="pill-dot" style={{ background: "var(--ok)" }} /> <b>{resolved}</b> flag(s) resolved after verification</div>
                    <div><span className="pill-dot" style={{ background: "var(--brand)" }} /> Reference built from <b>{cal.ingested}</b> of <b>{cal.size}</b> calibration bids · stability <b>{cal.stability}</b></div>
                  </div></div>
                <div className="card slide-r" style={delay(5)}><h3>Agent activity</h3><div className="hint">{d.run ? `${d.run.model} · ${d.run.status.replace(/_/g, " ").toLowerCase()}` : "No run yet"}</div>
                  <div className="feed" style={{ marginTop: 10, maxHeight: 360 }}>
                    {d.run?.plan && <div className="bubble" style={{ whiteSpace: "pre-wrap" }}>{d.run.plan}</div>}
                    {events.slice(-10).map((e, i) => <div key={i} className="tool"><Chip s={e.status} /><b>{e.tool}</b><span className="hint">{e.bid ?? ""}</span></div>)}
                    {!d.run && <div className="hint">Press Run analysis to start.</div>}</div></div>
              </div>
            </div></>)}

          {view === "bids" && <div className="card slide"><h3>All bids</h3><div style={{ overflowX: "auto" }}><table className="table"><thead><tr>{["Bid", "Supplier", "Role", "Status", "Price (USD)", "Delivery", "Docs", "Technical", "Findings"].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
            {bids.map((b) => <tr key={b.ref}><td><b>{b.ref}</b></td><td>{b.supplier}</td><td><Chip s={b.role} /></td><td><Chip s={bidStatus(b)} /></td><td>{b.metrics?.price_usd != null ? b.metrics.price_usd.toLocaleString() : "-"}</td><td>{b.metrics?.delivery_days ?? "-"}</td><td>{b.metrics ? pct(b.metrics.doc_completeness) : "-"}</td><td>{b.metrics?.technical_compliance != null ? pct(b.metrics.technical_compliance) : "-"}</td><td>{findings.filter((f) => f.bid === b.ref).map((f) => f.kind.replace(/_/g, " ")).join(", ") || "-"}</td></tr>)}</tbody></table></div></div>}

          {view === "calibration" && (<div className="grid g2">
            <div className="card slide" style={{ textAlign: "center" }}><h3>Calibration set</h3><div className="hint">First {pct(cal.size / cal.total)} of bids (1/e ≈ 36.8%)</div>
              <div style={{ display: "grid", placeItems: "center", margin: "14px 0" }}><Ring value={cal.size ? cal.ingested / cal.size : 0} size={170} label={`${cal.ingested} / ${cal.size}`} sub="calibration bids" /></div>
              <Chip s={cal.phase} /> <div className="hint" style={{ marginTop: 10 }}>Calibration bids define the reference. They are not rejected or ranked. Later bids are compared against it to decide which findings deserve investigation.</div></div>
            <div className="card slide" style={delay(1)}><h3>Reference distributions</h3><div className="hint">Stability {cal.stability} · version {cal.version}</div>
              <div className="bar" style={{ margin: "10px 0" }}><i style={{ width: pct(cal.stability) }} /></div>
              <table className="table"><thead><tr><th>Variable</th><th>n</th><th>Median</th><th>Scale</th><th>Min</th><th>Max</th></tr></thead><tbody>
                {Object.entries(cal.reference ?? {}).map(([k, v]: [string, Any]) => <tr key={k}><td>{k.replace(/_/g, " ")}</td><td>{v?.n}</td><td>{money(v?.median)}</td><td>{money(v?.scale)}</td><td>{money(v?.min)}</td><td>{money(v?.max)}</td></tr>)}</tbody></table>
              <div className="hint" style={{ marginTop: 10 }}>Experimental heuristic inspired by the secretary problem; not a procurement rule.</div></div></div>)}

          {view === "findings" && <div className="grid">{findings.length === 0 && <div className="card slide hint">No findings yet.</div>}
            {findings.map((f, i) => { const v = f.verification; return (<div key={f.id} className="card slide" style={delay(Math.min(i, 8))}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><b>{f.bid}</b><span>{f.kind.replace(/_/g, " ")}</span><Chip s={f.status} /><Chip s={f.severity.toUpperCase()} /></div>
              <div style={{ margin: "8px 0", fontSize: 14 }}>{f.description}</div>
              {v && <div style={{ fontSize: 13 }}>Verification: <b>{v.outcome?.replace(/_/g, " ")}</b>{v.note ? <span className="hint"> - {v.note}</span> : null}{v.contradictions?.length > 0 && <div style={{ color: "var(--bad)" }}>Contradictions: {v.contradictions.join(" · ")}</div>}</div>}
              {(v?.all_excerpts ?? []).map((x: Any, k: number) => <div key={k} className="excerpt"><b>{x.document}</b> · page {x.page} · {x.section}<div className="hint">{String(x.excerpt).replace(/<\/?untrusted_supplier_document_excerpt>/g, "")}</div></div>)}
              {v && !v.all_excerpts?.length && <div className="hint" style={{ marginTop: 6 }}>No source excerpt: {v.note || "Insufficient evidence - requires human review."}</div>}</div>); })}</div>}

          {view === "activity" && <div className="card slide"><h3>Agent activity</h3>{d.run?.plan && <div className="bubble" style={{ whiteSpace: "pre-wrap", margin: "10px 0" }}>{d.run.plan}</div>}
            {d.run?.human_flags?.length > 0 && <div className="chip warn">Flagged for humans: {d.run.human_flags.length}</div>}
            {events.length === 0 && <div className="hint" style={{ marginTop: 8 }}>No activity yet. Press Run analysis.</div>}
            {events.map((e, i) => <div key={i} style={{ borderTop: "1px solid var(--line)", padding: "9px 0", cursor: "pointer" }} onClick={() => setOpen(open === `e${i}` ? null : `e${i}`)}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}><code className="hint">{new Date(e.at).toLocaleTimeString()}</code><b>{e.tool}</b>{e.bid && <span>{e.bid}</span>}<Chip s={e.status} /><span className="hint">{e.node}</span></div>
              {e.reasoning && <div className="hint" style={{ marginTop: 3 }}>{e.reasoning}</div>}
              {open === `e${i}` && <pre className="excerpt" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ input: e.args, result: e.summary, audit_id: e.audit_id }, null, 2)}</pre>}</div>)}</div>}

          {view === "review" && (<div className="grid">
            <div className="card slide"><h3>Evaluation summary</h3>
              {!d.evaluation ? <div className="hint" style={{ marginTop: 8 }}>The committee file is generated at the end of a run.</div> : (() => { const p = d.evaluation.package; return (<>
                <div className="kv" style={{ margin: "12px 0" }}>{[["Bids processed", `${p.summary.bids_ingested}/${p.summary.bids_total}`], ["Calibration bids", p.summary.calibration_bids.length], ["Findings", p.summary.findings_total], ["Need human review", p.summary.findings_needing_human_review], ["Resolved on verification", p.summary.findings_resolved_after_verification], ["Missing-data flags", p.missing_data_flags.length], ["Audit records", p.audit_log.records]].map(([k, v]) => <div key={String(k)}><span className="hint">{k}</span><b>{String(v)}</b></div>)}</div>
                <div style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>Status <Chip s={d.evaluation.review_status} /> Audit chain <Chip s={d.audit.chain?.intact ? "INTACT" : "BROKEN"} /> Export {d.approvals.map((a: Any) => <Chip key={a.id} s={a.status} />)}</div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}><button className="btn primary" onClick={() => approve("APPROVED")}>Approve file export</button><button className="btn" onClick={() => approve("REJECTED")}>Reject</button></div>
                <h4>Missing information</h4>{p.missing_data_flags.slice(0, 30).map((m: Any, i: number) => <div key={i} className="hint">{m.bid}: {m.flag}</div>)}</>); })()}</div>
            <div className="card slide" style={delay(1)}><h3>Audit trail</h3><div className="hint">Append-only, hash-chained.</div><div className="feed" style={{ marginTop: 8 }}>{[...(d.audit.calls ?? [])].reverse().map((c: Any) => <div key={c.id} style={{ fontSize: 12, borderTop: "1px solid var(--line)", padding: "5px 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><code className="hint">#{c.id} {new Date(c.started_at).toLocaleTimeString()}</code><b>{c.tool_name}</b><span>{c.bid_id ?? ""}</span><Chip s={c.status} /><span className="hint">{c.actor}</span><span className="hint">{c.duration_ms}ms</span></div>)}</div></div></div>)}

          {view === "search" && (<div className="grid g-main">
            <div className="grid">
              <div className="card slide"><h3>Calibrated search</h3><div className="hint">Results are read in publication order. The first ~37% (1/e) set a per-currency value reference; later results that deviate strongly are marked “stands out” (worth a look, not “best”).</div>
                {!sr ? <div className="hint" style={{ padding: "26px 0" }}>Ask the assistant to search published procurement data, e.g. “Find laptop tenders in Kenya”.</div> : (<>
                  <div className="kv" style={{ margin: "12px 0" }}><div><span className="hint">Results</span><b>{sr.count}</b></div><div><span className="hint">Calibration set</span><b>{sr.calibration?.size} / {sr.calibration?.total}</b></div><div><span className="hint">Stand out</span><b>{sr.standouts}</b></div><div><span className="hint">Fraction</span><b>{pct(sr.calibration?.fraction ?? 0.368)}</b></div></div>
                  {sr.freshness?.length > 0 && <div className="hint">Freshness: {sr.freshness.map((f: Any) => `${f.source}: ${f.update_frequency}, last sync ${f.last_successful_sync ? new Date(f.last_successful_sync).toLocaleDateString() : "never"}`).join(" · ")}</div>}
                  {sr.available === false && <div className="chip warn">Open-contracting tables not found in this database.</div>}
                  {sr.message && <div className="hint">{sr.message}</div>}
                  <div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>#</th><th>Title</th><th>Country</th><th>Published</th><th>Estimated value</th><th>vs reference</th><th>Role</th></tr></thead><tbody>
                    {(sr.results ?? []).map((r: Any, i: number) => <tr key={r.ocid} title={r.ocid}><td>{i + 1}</td><td>{r.title}<div className="hint">{r.ocid}</div></td><td>{r.country}</td><td>{r.published_date ? new Date(r.published_date).toLocaleDateString() : "-"}</td><td>{r.estimated_value != null ? `${r.currency} ${r.estimated_value.toLocaleString()}` : "-"}</td><td>{r.deviation_pct != null ? `${r.deviation_pct > 0 ? "+" : ""}${(r.deviation_pct * 100).toFixed(0)}%` : "-"}</td><td><Chip s={r.stands_out ? "STANDS OUT" : r.role} /></td></tr>)}</tbody></table></div></>)}
              </div></div>
            <div className="card slide-r" style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
              <h3>Search assistant</h3><div className="hint">Model: {modelLabel(model)}</div>
              <div className="feed" ref={feedRef} style={{ flex: 1, margin: "12px 0" }}>
                {chat.length === 0 && ["Find laptop tenders in Kenya", "Find ICT hardware in Rwanda", "Find construction tenders in Ghana"].map((s) => <button key={s} className="btn" style={{ textAlign: "left" }} onClick={() => ask(s)}>{s}</button>)}
                {chat.map((m, i) => m.role === "user" ? <div key={i} className="bubble rise" style={{ alignSelf: "flex-end", background: "var(--brand)", color: "#fff" }}>{m.text}</div> :
                  <div key={i} className="rise"><div className="bubble" style={m.error ? { background: "#fde6e6", color: "#b42a2f" } : {}}>{m.text}</div>
                    {m.events?.map((e: Any, k: number) => <div key={k} className="tool" style={{ marginTop: 6 }}><Chip s={e.status} /><b>{e.tool}</b><span className="hint">{JSON.stringify(e.args).slice(0, 80)}</span></div>)}
                    {m.model && <div className="hint" style={{ marginTop: 4 }}>{m.model}</div>}</div>)}
                {searching && <div className="hint live">Searching…</div>}</div>
              <form onSubmit={(e) => { e.preventDefault(); ask(q); }} style={{ display: "grid", gap: 8 }}>
                <input className="tok" style={{ width: "100%" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find procurement data…" aria-label="Search query" />
                <div style={{ display: "flex", gap: 8 }}>{Models}<button className="btn primary" style={{ marginLeft: "auto" }} disabled={searching || !q.trim()}>Send</button></div></form>
            </div></div>)}
        </div>)}
      </main>
    </div>
  );
}
