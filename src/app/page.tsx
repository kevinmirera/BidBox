"use client";
import { useCallback, useEffect, useState } from "react";

type Any = any;
const TABS = ["Dashboard", "Agent Activity", "Calibration", "Investigations", "Committee Review"] as const;
const C = { bg: "#0f1115", card: "#171a21", line: "#262b36", mute: "#8b93a7", ok: "#3ecf8e", warn: "#f5a524", bad: "#f2555a", accent: "#6ea8fe" };
const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 };
const badgeColor = (s: string) => (/VERIFIED|CONFIRMED|SUCCESS|COMPLETE|CALIBRATED/.test(s) ? C.ok : /MISSING|ERROR|CONTRADICT|FAIL/.test(s) ? C.bad : /INVESTIGATE|FLAG|PAUSED|PROVISIONAL|RESOLVED|PENDING/.test(s) ? C.warn : C.mute);
const Badge = ({ s }: { s: string }) => <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${badgeColor(s)}`, color: badgeColor(s), whiteSpace: "nowrap" }}>{s}</span>;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: any) => (typeof x === "number" ? x.toLocaleString() : "-");

export default function Page() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Dashboard");
  const [token, setToken] = useState("");
  const [d, setD] = useState<Any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const hdr = useCallback((): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {}), [token]);
  const load = useCallback(async () => {
    const r = await fetch("/api/dashboard", { headers: hdr() });
    const j = await r.json();
    if (!r.ok) { setErr(j.error || "failed"); return; }
    setErr(""); setD(j);
  }, [hdr]);
  useEffect(() => { try { setToken(sessionStorage.getItem("bb_token") || ""); } catch {} }, []);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  const start = async (provider?: string) => {
    setBusy(true);
    try {
      const r = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json", ...hdr() }, body: JSON.stringify({ tender_id: "TND-2026-014", batch_size: 25, ...(provider ? { provider } : {}) }) });
      const j = await r.json(); if (!r.ok) setErr(j.error || "run failed");
    } finally { setBusy(false); load(); }
  };
  const approve = async (status: "APPROVED" | "REJECTED") => {
    const approver = prompt("Your name (recorded as the human approver):"); if (!approver) return;
    const r = await fetch("/api/approvals", { method: "POST", headers: { "content-type": "application/json", ...hdr() }, body: JSON.stringify({ evaluation_id: d.evaluation.id, status, approver, note: "via dashboard" }) });
    if (!r.ok) setErr((await r.json()).error); load();
  };

  const ev = d?.run?.events ?? [];
  const cal = d?.calibration;
  const bids = d?.bids ?? [];
  const processed = bids.filter((b: Any) => !["RECEIVED"].includes(b.status)).length;
  const runtime = d?.run ? Math.round(((d.run.finished_at ? new Date(d.run.finished_at) : new Date()).getTime() - new Date(d.run.started_at).getTime()) / 1000) : 0;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div><h1 style={{ margin: 0, fontSize: 22 }}>Bid Box</h1><div style={{ color: C.mute, fontSize: 13 }}>Agentic procurement analysis. Investigation only, never an award.</div></div>
        <input placeholder="Admin token (if configured)" value={token} onChange={(e) => { setToken(e.target.value); try { sessionStorage.setItem("bb_token", e.target.value); } catch {} }} type="password" style={{ background: C.card, color: "#e6e8ee", border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", width: 220 }} />
      </header>

      <div style={{ ...card, marginTop: 16, borderColor: C.warn, textAlign: "center" }}>
        <div style={{ fontWeight: 800, letterSpacing: 1.5, color: C.warn }}>NO AWARD DECISION MADE BY BID BOX</div>
        <div style={{ color: C.mute, fontSize: 13 }}>FINAL PROCUREMENT DECISION: HUMAN COMMITTEE &nbsp;|&nbsp; Award decisions made: <b style={{ color: "#e6e8ee" }}>0</b></div>
      </div>

      {err && <div style={{ ...card, borderColor: C.bad, color: C.bad }}>{err}</div>}

      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? C.accent : C.card, color: tab === t ? "#0b1020" : "#e6e8ee", border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontWeight: 600 }}>{t}</button>)}
      </nav>

      {!d ? <div style={card}>Loading…</div> : tab === "Dashboard" && (<>
        <div style={card}>
          <b>{d.tender.ref}</b> - {d.tender.title}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 12 }}>
            {[["Bids", bids.length], ["Processed", `${processed} / ${bids.length}`], ["Calibration", `${cal.ingested} / ${cal.size}`], ["Investigations", d.findings.length], ["Evidence records", d.evidence.length], ["Runtime", `${runtime}s`], ["Run status", d.run?.status ?? "NOT STARTED"], ["Model", d.run?.model ?? "-"]].map(([k, v]) => (
              <div key={String(k)} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}><div style={{ color: C.mute, fontSize: 12 }}>{k}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{String(v)}</div></div>))}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={busy} onClick={() => start()} style={{ background: C.accent, border: 0, borderRadius: 8, padding: "9px 14px", fontWeight: 700, cursor: "pointer" }}>{busy ? "Running…" : "Run analysis (configured model)"}</button>
            <button disabled={busy} onClick={() => start("scripted")} title="Test double, not an LLM. For offline demos/CI." style={{ background: C.card, color: "#e6e8ee", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>Run with scripted test provider</button>
          </div>
          <div style={{ color: C.mute, fontSize: 12, marginTop: 8 }}>MCP endpoint: <code>{d.mcp_endpoint}</code></div>
        </div>
        <div style={card}>
          <b>Bid stream</b>
          <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 13 }}>
            <thead><tr style={{ color: C.mute, textAlign: "left" }}>{["Bid", "Supplier (as submitted)", "Role", "Status", "Price (USD)", "Delivery", "Doc compl.", "Tech compl.", "Flags", "Evidence"].map((h) => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
            <tbody>{bids.map((b: Any) => {
              const fs = d.findings.filter((f: Any) => f.bid === b.ref);
              const ev = fs.length === 0 ? "-" : fs.some((f: Any) => f.status === "EVIDENCE_MISSING") ? "EVIDENCE MISSING" : fs.some((f: Any) => f.status === "OPEN") ? "UNVERIFIED" : "EVIDENCE VERIFIED";
              const st = b.role === "CALIBRATION" && b.status !== "RECEIVED" ? "CALIBRATION" : fs.some((f: Any) => f.status === "OPEN") ? "INVESTIGATE" : b.status === "RECEIVED" ? "QUEUED" : b.status === "INGESTED" ? "ANALYSING" : fs.length ? "REVIEW" : "ANALYSED";
              return (<tr key={b.ref} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={{ padding: 6 }}><b>{b.ref}</b></td><td>{b.supplier}</td><td>{b.role}</td><td><Badge s={st} /></td>
                <td>{num(b.metrics?.price_usd)}</td><td>{b.metrics?.delivery_days ?? "-"}</td><td>{b.metrics ? pct(b.metrics.doc_completeness) : "-"}</td><td>{b.metrics?.technical_compliance != null ? pct(b.metrics.technical_compliance) : "-"}</td>
                <td>{fs.map((f: Any) => f.kind).join(", ") || "-"}</td><td><Badge s={ev} /></td></tr>);
            })}</tbody></table></div>
        </div>
      </>)}

      {d && tab === "Agent Activity" && (
        <div style={card}>
          <b>Claude reasoning step → MCP tool call → result → next action</b>
          {d.run?.plan && <pre style={{ whiteSpace: "pre-wrap", background: "#0c0e13", padding: 10, borderRadius: 8, fontSize: 12 }}>Plan: {d.run.plan}</pre>}
          {d.run?.human_flags?.length > 0 && <div style={{ color: C.warn }}>Flagged for humans: {d.run.human_flags.join(" | ")}</div>}
          {ev.length === 0 && <div style={{ color: C.mute, marginTop: 8 }}>No activity yet. Start a run from the Dashboard tab.</div>}
          {ev.map((e: Any, i: number) => (
            <div key={i} style={{ borderTop: `1px solid ${C.line}`, padding: "8px 0", cursor: "pointer" }} onClick={() => setOpen(open === i ? null : i)}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                <code style={{ color: C.mute }}>{new Date(e.at).toLocaleTimeString()}</code><b>{e.tool}</b>{e.bid && <span>{e.bid}</span>}<Badge s={e.status} /><span style={{ color: C.mute }}>{e.node}</span>
              </div>
              {e.reasoning && <div style={{ color: C.mute, fontSize: 12, marginTop: 4 }}>reasoning: {e.reasoning}</div>}
              {open === i && <pre style={{ whiteSpace: "pre-wrap", background: "#0c0e13", padding: 10, borderRadius: 8, fontSize: 11 }}>{JSON.stringify({ input: e.args, result_summary: e.summary, audit_id: e.audit_id }, null, 2)}</pre>}
            </div>))}
        </div>
      )}

      {d && tab === "Calibration" && (
        <div style={card}>
          <b>Investigation calibration</b> <span style={{ color: C.mute, fontSize: 12 }}>(not a winning threshold)</span>
          <div style={{ fontSize: 24, margin: "10px 0" }}>{cal.ingested} / {cal.size} calibration bids <Badge s={cal.phase} /></div>
          <div style={{ background: "#0c0e13", borderRadius: 8, height: 14, overflow: "hidden" }}><div style={{ width: pct(cal.size ? cal.ingested / cal.size : 0), height: "100%", background: C.accent }} /></div>
          <div style={{ color: C.mute, fontSize: 12, marginTop: 6 }}>{cal.size} of {cal.total} bids = ~{pct(cal.size / cal.total)} (1/e ≈ 36.8%). Calibration bids are not rejected or ranked; they only define the reference.</div>
          <div style={{ marginTop: 14 }}>Stability: <b>{cal.stability}</b> <span style={{ color: C.mute, fontSize: 12 }}>(1.0 = reference barely moves if any one calibration bid is removed) · reference v{cal.version}</span></div>
          <table style={{ width: "100%", marginTop: 12, fontSize: 13, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: C.mute, textAlign: "left" }}><th>Variable</th><th>n</th><th>Median</th><th>Robust scale</th><th>Min</th><th>Max</th></tr></thead>
            <tbody>{Object.entries(cal.reference ?? {}).map(([k, v]: [string, Any]) => <tr key={k} style={{ borderTop: `1px solid ${C.line}` }}><td>{k}</td><td>{v?.n}</td><td>{num(v?.median)}</td><td>{num(v?.scale)}</td><td>{num(v?.min)}</td><td>{num(v?.max)}</td></tr>)}</tbody></table>
          <div style={{ marginTop: 12, color: C.mute, fontSize: 12 }}>Experimental investigation-allocation heuristic inspired by the secretary problem. Not a procurement rule or legal threshold.</div>
        </div>
      )}

      {d && tab === "Investigations" && (
        <div>{d.findings.length === 0 && <div style={card}>No findings yet.</div>}
          {d.findings.map((f: Any) => {
            const evs = d.evidence.filter((e: Any) => (f.evidence_ids ?? []).includes(e.id));
            const v = f.verification;
            return (<div key={f.id} style={card}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><b>{f.bid}</b><span>{f.kind}</span><Badge s={f.status} /><Badge s={f.severity.toUpperCase()} /></div>
              <div style={{ margin: "6px 0" }}>{f.description}</div>
              <div style={{ color: C.mute, fontSize: 12 }}>Why flagged: deterministic check/calibration trigger. {d.scenarios[f.bid] ? `Demo scenario: ${d.scenarios[f.bid]}` : ""}</div>
              {v && <div style={{ marginTop: 8, fontSize: 13 }}>Verification: <b>{v.outcome}</b> {v.note && <span style={{ color: C.mute }}>- {v.note}</span>}{v.contradictions?.length > 0 && <div style={{ color: C.bad }}>Contradictions: {v.contradictions.join(" · ")}</div>}</div>}
              {(v?.all_excerpts ?? []).map((x: Any, i: number) => <div key={i} style={{ marginTop: 6, background: "#0c0e13", padding: 8, borderRadius: 8, fontSize: 12 }}><b>{x.document}</b> · page {x.page} · {x.section}<div style={{ color: C.mute }}>{String(x.excerpt).replace(/<\/?untrusted_supplier_document_excerpt>/g, "")}</div></div>)}
              {!v && evs.map((e: Any) => <div key={e.id} style={{ marginTop: 6, fontSize: 12, color: C.mute }}>{e.document} · p{e.page} · {e.section}</div>)}
              {v && !v.all_excerpts?.length && <div style={{ marginTop: 6, fontSize: 12, color: C.warn }}>No source excerpt: {v.note || "Insufficient evidence - requires human review."}</div>}
            </div>);
          })}</div>
      )}

      {d && tab === "Committee Review" && (<>
        <div style={card}>
          <b>Evaluation summary</b>
          {!d.evaluation ? <div style={{ color: C.mute, marginTop: 8 }}>No committee file yet. It is generated at the end of a run.</div> : (() => {
            const p = d.evaluation.package; return (<>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, margin: "10px 0" }}>
                {[["Bids processed", `${p.summary.bids_ingested}/${p.summary.bids_total}`], ["Calibration bids", p.summary.calibration_bids.length], ["Findings", p.summary.findings_total], ["Need human review", p.summary.findings_needing_human_review], ["Resolved on verification", p.summary.findings_resolved_after_verification], ["Missing-data flags", p.missing_data_flags.length], ["Audit records", p.audit_log.records], ["Award decisions", 0]].map(([k, v]) => <div key={String(k)} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}><div style={{ color: C.mute, fontSize: 12 }}>{k}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{String(v)}</div></div>)}
              </div>
              <div style={{ fontSize: 13 }}>Review status: <Badge s={d.evaluation.review_status} /> · Audit chain: <Badge s={d.audit.chain?.intact ? "SUCCESS INTACT" : "ERROR BROKEN"} /></div>
              <div style={{ marginTop: 10, fontSize: 13 }}>Export approval: {d.approvals.map((a: Any) => <span key={a.id} style={{ marginRight: 8 }}><Badge s={a.status} /> {a.approver ?? ""}</span>)}</div>
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => approve("APPROVED")} style={{ background: C.ok, border: 0, borderRadius: 8, padding: "9px 14px", fontWeight: 700, cursor: "pointer" }}>Approve file export (human)</button>
                <button onClick={() => approve("REJECTED")} style={{ background: C.card, color: "#e6e8ee", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>Reject</button>
              </div>
              <div style={{ color: C.mute, fontSize: 12, marginTop: 6 }}>Approving the export is not an award. No Bid Box tool or route can award a tender.</div>
              <h4>Missing information</h4>
              {p.missing_data_flags.slice(0, 40).map((m: Any, i: number) => <div key={i} style={{ fontSize: 12, color: C.mute }}>{m.bid}: {m.flag}</div>)}
            </>); })()}
        </div>
        <div style={card}><b>Audit trail</b> <span style={{ color: C.mute, fontSize: 12 }}>(append-only, hash-chained)</span>
          <div style={{ maxHeight: 360, overflow: "auto", marginTop: 8 }}>{[...(d.audit.calls ?? [])].reverse().map((c: Any) => <div key={c.id} style={{ fontSize: 12, borderTop: `1px solid ${C.line}`, padding: "4px 0", display: "flex", gap: 10, flexWrap: "wrap" }}><code style={{ color: C.mute }}>#{c.id} {new Date(c.started_at).toLocaleTimeString()}</code><b>{c.tool_name}</b><span>{c.bid_id ?? ""}</span><Badge s={c.status} /><span style={{ color: C.mute }}>{c.actor}</span><span style={{ color: C.mute }}>{c.duration_ms}ms</span></div>)}</div>
        </div>
      </>)}
    </div>
  );
}
