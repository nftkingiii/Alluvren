import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileCheck2,
  Fingerprint,
  History,
  Layers3,
  LayoutDashboard,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  AlertTriangle,
  CheckCircle2,
  Info,
  Asterisk,
  Compass,
  Leaf,
  Radio,
} from "lucide-react";
import { ConnectionPanel, useGovernanceEvidence } from "./ConnectionPanel.jsx";
import { LiveLedger } from "./LiveLedger.jsx";
import {
  allocate,
  investors,
  initialState,
  transition,
  canExecute,
} from "./domain.js";
import "./styles.css";

const fmt = (n) => n.toLocaleString("en-US");
const tabs = [
  { id: "desk", name: "Desk", icon: LayoutDashboard },
  { id: "requests", name: "Requests", icon: Users },
  { id: "batches", name: "Batches", icon: Layers3 },
  { id: "approvals", name: "Approvals", icon: ShieldCheck },
  { id: "activity", name: "Activity", icon: History },
  { id: "live", name: "Live ledger", icon: Radio },
];
const status = (b, active) =>
  b.executed
    ? "Finalized"
    : b.version !== active
      ? "Superseded"
      : b.approvals.length === 2
        ? b.confirmations.length >= 2
          ? "Ready to finalize"
          : "Awaiting confirmations"
        : "Awaiting review";
const activityKinds = {
  batch: "Batch opened",
  request: "Window activity",
  approve: "Business approval",
  replace: "Batch change",
  confirm: "Member confirmation",
  execute: "Finalization",
  claim: "Allocation acknowledgement",
};
function Badge({ children, tone = "" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Button({ children, icon: Icon, className = "", ...props }) {
  return (
    <button className={`button ${className}`} {...props}>
      {Icon && <Icon size={16} />} {children}
    </button>
  );
}
function Metric({ label, value, suffix = "units", note, tone }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <div className={tone || ""}>
        {value} <small>{suffix}</small>
      </div>
      <p>{note}</p>
    </div>
  );
}
function Avatar({ person }) {
  const Mark =
    person.avatarStyle === "aster"
      ? Asterisk
      : person.avatarStyle === "meridian"
        ? Compass
        : Leaf;
  return (
    <span className={`avatar avatar-${person.avatarStyle}`} aria-hidden="true">
      <Mark size={16} strokeWidth={1.8} />
    </span>
  );
}
function readImageData(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      canvas.getContext("2d").drawImage(image, 0, 0, 128, 128);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Brand image could not be loaded"));
    image.src = url;
  });
}
async function exportPdfReport({ title, state, version, allocations, events, investor }) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = 210;
  const margin = 16;
  const contentWidth = pageWidth - margin * 2;
  const paper = [247, 246, 239];
  const ink = [30, 37, 31];
  const muted = [103, 111, 101];
  const line = [220, 221, 210];
  const sage = [91, 119, 79];
  const gold = [183, 150, 76];
  const batch = state.versions.find((item) => item.version === version) || state.versions.at(-1);
  const amount = allocations.reduce((sum, row) => sum + row.allocated, 0);
  let y = 72;
  const mark = await readImageData("/alluvren-mark.png");

  doc.setFillColor(...paper);
  doc.rect(0, 0, pageWidth, 297, "F");
  doc.setFillColor(...ink);
  doc.rect(0, 0, pageWidth, 55, "F");
  doc.addImage(mark, "PNG", margin, 11, 11, 11);
  doc.setTextColor(248, 247, 240);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("alluvren", 31, 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(187, 194, 181);
  doc.text("PRIVATE REDEMPTION DESK  /  DEMO REPORT", 31, 25);
  doc.setDrawColor(...gold);
  doc.setLineWidth(0.7);
  doc.line(margin, 34, margin + 16, 34);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(248, 247, 240);
  doc.text(title, margin, 44);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(206, 211, 201);
  doc.text("Northstar Private Credit  ·  Window 01  ·  Version " + batch.version, margin, 50);
  doc.setFontSize(8);
  doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth - margin, 19, { align: "right" });

  const summary = [
    ["REQUESTED", allocations.reduce((sum, row) => sum + row.units, 0), "units"],
    [investor ? "YOUR ALLOCATION" : "ALLOCATED", amount, "units"],
    ["OUTSTANDING", allocations.reduce((sum, row) => sum + row.outstanding, 0), "units"],
  ];
  const boxGap = 4;
  const boxWidth = (contentWidth - boxGap * 2) / 3;
  summary.forEach(([label, value, unit], index) => {
    const x = margin + index * (boxWidth + boxGap);
    doc.setDrawColor(...line);
    doc.setFillColor(252, 251, 247);
    doc.roundedRect(x, 61, boxWidth, 27, 2, 2, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...muted);
    doc.text(label, x + 4, 68);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...(index === 1 ? sage : ink));
    doc.text(Number(value).toLocaleString("en-US"), x + 4, 80);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...muted);
    doc.text(unit, x + boxWidth - 4, 80, { align: "right" });
  });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...ink);
  doc.text(investor ? "Allocation statement" : "Allocation schedule", margin, 101);
  const colX = [margin, 88, 121, 153, 184];
  const headings = ["INVESTOR", "REQUESTED", "ALLOCATED", "OUTSTANDING", "FULFILMENT"];
  doc.setFillColor(231, 233, 223);
  doc.roundedRect(margin, 106, contentWidth, 10, 1.5, 1.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.5);
  doc.setTextColor(...muted);
  headings.forEach((label, index) =>
    doc.text(label, colX[index], 112.5, { align: index ? "right" : "left" }),
  );
  y = 124;
  allocations.forEach((row, index) => {
    doc.setDrawColor(...line);
    doc.line(margin, y + 5, pageWidth - margin, y + 5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...ink);
    doc.text(row.name, colX[0], y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    [row.units, row.allocated, row.outstanding].forEach((value, i) =>
      doc.text(Number(value).toLocaleString("en-US"), colX[i + 1], y, { align: "right" }),
    );
    const fulfillment = row.units ? Math.round((row.allocated / row.units) * 100) : 0;
    doc.setTextColor(...sage);
    doc.text(`${fulfillment}%`, colX[4], y, { align: "right" });
    doc.setTextColor(...muted);
    doc.setFontSize(7);
    doc.text(row.id, colX[0], y + 4);
    y += 14;
  });

  y += 5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...ink);
  doc.text("Review status", margin, y);
  y += 8;
  const approvals = `${batch.approvals.length}/2 business reviews`;
  const confirmations = `${batch.confirmations.length}/2 member confirmations`;
  const finalStatus = batch.executed ? "Finalized in demo" : "Not finalized";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...muted);
  doc.text(`${approvals}  ·  ${confirmations}  ·  ${finalStatus}`, margin, y);
  y += 11;

  if (events?.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...ink);
    doc.text("Activity", margin, y);
    y += 7;
    for (const event of events) {
      const detailLines = doc.splitTextToSize(event.detail, contentWidth - 38);
      const rowHeight = Math.max(16, detailLines.length * 4 + 9);
      if (y + rowHeight > 270) {
        doc.addPage();
        doc.setFillColor(...paper);
        doc.rect(0, 0, pageWidth, 297, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(...ink);
        doc.text("Activity continued", margin, 18);
        y = 25;
      }
      doc.setDrawColor(...line);
      doc.roundedRect(margin, y, contentWidth, rowHeight, 2, 2, "S");
      doc.setFillColor(...(event.type === "replace" ? gold : sage));
      doc.circle(margin + 5, y + 6, 1.4, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...ink);
      doc.text(event.title, margin + 10, y + 6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(...muted);
      doc.text(event.time, pageWidth - margin - 4, y + 6, { align: "right" });
      doc.text(detailLines, margin + 10, y + 11);
      y += rowHeight + 3;
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...line);
    doc.line(margin, 280, pageWidth - margin, 280);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...muted);
    doc.text("Illustrative demo data. No assets moved and no ledger action was submitted.", margin, 285);
    doc.text(`Alluvren  ·  Page ${page} of ${pageCount}`, pageWidth - margin, 285, { align: "right" });
  }
  const suffix = investor ? "allocation" : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  doc.save(`alluvren-${suffix}-v${batch.version}.pdf`);
}
function Toast({ toast, dismiss, pause }) {
  if (!toast) return null;
  return (
    <div
      className={`toast ${toast.tone}`}
      role="status"
      onMouseEnter={() => pause(true)}
      onMouseLeave={() => pause(false)}
      onFocus={() => pause(true)}
      onBlur={() => pause(false)}
    >
      {toast.tone === "success" ? (
        <CheckCircle2 size={17} />
      ) : toast.tone === "error" ? (
        <AlertTriangle size={17} />
      ) : (
        <Info size={17} />
      )}
      {toast.message}
      <button
        className="icon-button"
        aria-label="Dismiss notification"
        onClick={dismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}
function Modal({ title, children, onClose, drawer = false, feedback }) {
  const ref = useRef();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      queueMicrotask(() => {
        if (trigger instanceof HTMLElement && trigger.isConnected)
          trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      aria-label={title}
      className={drawer ? "drawer" : ""}
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
      {feedback}
    </dialog>
  );
}
function App() {
  const [state, setState] = useState(initialState);
  const [tab, setTab] = useState("desk");
  const [version, setVersion] = useState(1);
  const [modal, updateModal] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [reserveError, setReserveError] = useState("");
  const setModal = (value) => {
    setActionError(null);
    setReserveError("");
    updateModal(value);
  };
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [reserve, setReserve] = useState(40000);
  const [requestAmount, setRequestAmount] = useState(60000);
  const [requestError, setRequestError] = useState("");
  const [nextWindowRequest, setNextWindowRequest] = useState(null);
  const [toast, setToast] = useState(null);
  const [toastPaused, setToastPaused] = useState(false);
  const [persona, setPersona] = useState("operator");
  const [activityFilter, setActivityFilter] = useState("all");
  const current = state.versions.at(-1);
  const navigation = useRef(null);
  const batch = ["batches", "approvals"].includes(tab)
    ? state.versions.find((b) => b.version === version) || current
    : current;
  const swipe = useRef(null);
  const rows = allocate(investors, batch.liquidity);
  const filteredRequests = rows.filter(
    (r) =>
      `${r.name} ${r.id}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "outstanding" && r.outstanding > 0) ||
        (filter === "full" && r.outstanding === 0)),
  );
  const stale = batch.version !== state.active;
  const percent = Math.round(batch.liquidity / 1000);
  const ready = canExecute(state, version);
  const announce = (message, tone = "success") => {
    setToastPaused(false);
    setToast({ message, tone, id: Date.now() });
  };
  const exportReport = (report) =>
    exportPdfReport(report)
      .then(() => announce("PDF report downloaded."))
      .catch(() =>
        announce("PDF export failed. Check browser download access and retry.", "error"),
      );
  const { connection, checkConnection, cancelConnection } =
    useGovernanceEvidence(announce);
  const feedback = (
    <Toast
      toast={toast}
      dismiss={() => setToast(null)}
      pause={setToastPaused}
    />
  );
  useEffect(() => {
    if (toast && !toastPaused) {
      const t = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(t);
    }
  }, [toast, toastPaused]);
  useEffect(() => {
    const active = navigation.current?.querySelector('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
  }, [tab, persona]);
  const act = (type, extra = {}) => {
    try {
      const next = transition(state, {
        type,
        version,
        time: new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        id: crypto.randomUUID(),
        ...extra,
      });
      setState(next);
      if (type === "replace") setVersion(next.active);
      announce(next.events[0].title);
      setModal(null);
    } catch (e) {
      setActionError(e.message);
    }
  };
  const go = (target) => {
    setTab(target);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const table = (data, requests = false) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Investor</th>
            <th>Request</th>
            <th className="numeric">Requested</th>
            {!requests && (
              <>
                <th className="numeric">Allocated</th>
                <th className="numeric">Outstanding</th>
              </>
            )}
            <th>{requests ? "Received" : "Fulfillment"}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              aria-label={`View ${r.name} request details`}
              onClick={() => setSelected(r)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(r);
                }
              }}
            >
              <td>
                <div className="investor">
                  <Avatar person={r} />
                  <span>
                    {r.name}
                    <small>Sample investor</small>
                  </span>
                </div>
              </td>
              <td className="mono muted">{r.id}</td>
              <td className="numeric">
                {fmt(r.units)}
                <small className="unit">units</small>
              </td>
              {!requests && (
                <>
                  <td className="numeric sage-text">
                    {fmt(r.allocated)}
                    <small className="unit">units</small>
                  </td>
                  <td className="numeric muted">
                    {fmt(r.outstanding)}
                    <small className="unit">units</small>
                  </td>
                </>
              )}
              <td>
                {requests ? (
                  <span className="muted">{r.received}</span>
                ) : (
                  <div className="fulfillment">
                    <div className="mini-track">
                      <i
                        style={{ width: `${(r.allocated / r.units) * 100}%` }}
                      />
                    </div>
                    <span>{Math.round((r.allocated / r.units) * 100)}%</span>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        {data.length > 0 && !requests && (
          <tfoot>
            <tr>
              <td colSpan={2}>Total allocation</td>
              <td className="numeric">100,000</td>
              <td className="numeric sage-text">{fmt(batch.liquidity)}</td>
              <td className="numeric">{fmt(100000 - batch.liquidity)}</td>
              <td>{percent}% fulfilled</td>
            </tr>
          </tfoot>
        )}
      </table>
      {!data.length && (
        <div className="empty">
          <Search size={24} />
          <h3>No matching requests</h3>
          <p>
            {query ? (
              <>
                No results for <strong>“{query}”</strong>
                {filter !== "all" ? " with the selected allocation filter" : ""}
                .
              </>
            ) : (
              "No requests match the selected allocation filter."
            )}{" "}
            All 3 requests are still available.
          </p>
          <div className="empty-actions">
            {query && (
              <Button onClick={() => setQuery("")}>Clear search</Button>
            )}
            {filter !== "all" && (
              <Button onClick={() => setFilter("all")}>Reset filters</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app-shell">
      <header className="header">
        <div className="fund-label" aria-label="Current fund: Northstar Private Credit">
          <img className="fund-avatar" src="/northstar-emblem.png" alt="" />
          <div>
            Northstar Private Credit<small>Window 01</small>
          </div>
        </div>
        <div className="header-right">
          <button
            className="environment"
            aria-label="Demo workspace"
            onClick={() => setModal("connection")}
          >
            <span className="status-dot neutral" />
            Demo · local
            <ChevronDown size={14} />
          </button>
          <button
            className="icon-button help"
            aria-label="About this demo"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={19} />
          </button>
          <button
            className="account"
            onClick={() => setModal("persona")}
            aria-label="Switch demo perspective"
          >
            {persona === "operator" ? "JD" : "AC"}
          </button>
        </div>
      </header>
      <aside className="nav-band">
        <a
          href="#desk"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            go(persona === "investor" ? "investor" : "desk");
          }}
        >
          <img className="brand-mark-img" src="/alluvren-mark.png" alt="" />
          <span className="brand-name">alluvren<span className="brand-dot">.</span></span>
        </a>
        <div className="nav-section-label">WORKSPACE</div>
        <div className="nav-scroll" ref={navigation}>
          <nav aria-label="Main navigation">
            {(persona === "operator"
              ? tabs
              : [
                  { id: "investor", name: "My redemption", icon: Wallet },
                  { id: "live", name: "Live ledger", icon: Radio },
                ]
            ).map((t) => (
              <button
                key={t.id}
                className={`nav-item ${tab === t.id ? "active" : ""}`}
                aria-current={tab === t.id ? "page" : undefined}
                aria-label={
                  t.id === "approvals" && current.approvals.length < 2
                    ? `Approvals, ${2 - current.approvals.length} reviews needed`
                    : t.name
                }
                onClick={(e) => {
                  go(t.id);
                  if (e.detail > 0) e.currentTarget.blur();
                }}
              >
                <t.icon size={17} />
                <span className="nav-label">{t.name}</span>
                {t.id === "approvals" && current.approvals.length < 2 && (
                  <span className="nav-count" aria-hidden="true">
                    {2 - current.approvals.length}
                    <span> to review</span>
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        {persona === "operator" && (
          <div className="nav-bottom">
            <span className="status-dot neutral" />
            <span><strong>Demo workspace</strong><small>September 2026 · Window 01</small></span>
            <button className="icon-button" aria-label="Workspace settings" onClick={() => setModal("help")}>
              <CircleHelp size={16} />
            </button>
          </div>
        )}
      </aside>
      <main
        onTouchStart={(e) => {
          if (e.target.closest(".batch-top"))
            swipe.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
            };
        }}
        onTouchEnd={(e) => {
          if (!swipe.current) return;
          const dx = e.changedTouches[0].clientX - swipe.current.x;
          const dy = e.changedTouches[0].clientY - swipe.current.y;
          if (Math.abs(dx) > 70 && Math.abs(dy) < 40)
            setVersion((v) =>
              Math.max(1, Math.min(state.active, v + (dx < 0 ? 1 : -1))),
            );
          swipe.current = null;
        }}
      >
        <div className="page-heading">
          <div>
            <h1>
              {tab === "live"
                ? "Live ledger"
                : persona === "investor"
                ? "My redemption"
                : {
                    desk: "Redemption desk",
                    requests: "Redemption requests",
                    batches: "Batch review",
                    approvals: "Review & approve",
                    activity: "Activity & evidence",
                  }[tab]}
            </h1>
            {persona === "operator" && tab === "desk" && (
              <p>September 2026 <span>/</span> Window 01 <span>/</span> 3 investor requests</p>
            )}
            {persona === "investor" && (
              <p>Aster Capital / Northstar Private Credit</p>
            )}
          </div>
          <div className="heading-actions">
            {tab !== "live" && <Button
              icon={Download}
              className="quiet"
              onClick={() =>
                exportReport({
                  title:
                    persona === "investor"
                      ? "Investor allocation statement"
                      : tab === "activity"
                        ? "Window activity report"
                        : "Redemption audit report",
                  state,
                  version: current.version,
                  allocations:
                    persona === "investor"
                      ? [allocate(investors, current.liquidity)[0]]
                      : allocate(investors, current.liquidity),
                  events: persona === "operator" ? state.events : [],
                  investor:
                    persona === "investor"
                      ? allocate(investors, current.liquidity)[0]
                      : null,
                })
              }
            >
              {persona === "operator" ? "Export PDF" : "Export my PDF"}
            </Button>}
            {persona === "operator" &&
              ["desk", "requests", "activity"].includes(tab) && (
                <Button
                  icon={tab === "desk" ? ArrowRight : Layers3}
                  className="primary"
                  onClick={() => {
                    setVersion(state.active);
                    go(
                      tab === "desk" || tab === "approvals"
                        ? "batches"
                        : "approvals",
                    );
                  }}
                >
                  {tab === "desk"
                    ? "Review batch"
                    : tab === "approvals"
                      ? "View allocation"
                      : "Open approvals"}
                </Button>
              )}
          </div>
        </div>
        {tab === "live" ? (
          <div className="demo-strip">
            <span>
              <span className="demo-tag">LOCALNET</span>Actions submit real Daml
              commands to BitSafe LocalNet. No assets move.
            </span>
          </div>
        ) : (
          <div className="demo-strip">
            <span>
              <span className="demo-tag">DEMO</span>Simulated allocations and
              approvals. No assets move.
            </span>
            <button onClick={() => setModal("reset")}>
              Reset demo
              <RefreshCw size={12} />
            </button>
          </div>
        )}

        <div key={`${tab}-${persona}`} className="view-enter">
          {tab === "desk" && persona === "operator" && (
            <>
              <section className="metrics">
                <Metric
                  label="Total requested"
                  value="100,000"
                  note="3 investor requests"
                />
                <Metric
                  label="Available reserve"
                  value={fmt(current.liquidity)}
                  note="Demonstration liquidity"
                  tone="sage-text"
                />
                <Metric
                  label="Unallocated"
                  value={fmt(100000 - current.liquidity)}
                  note="Remains outstanding"
                  tone="gold-text"
                />
                <Metric
                  label="Business approvals"
                  value={`${current.approvals.length} / 2`}
                  suffix="roles"
                  note="Fund + treasury review"
                />
              </section>
              <div className="desk-quickbar">
                <div className="quickbar-state">
                  <Badge tone={current.executed ? "success" : "warning"}>
                    {current.executed ? "Finalized" : current.liquidity === 100000 ? "Fully covered" : "Partial liquidity"}
                  </Badge>
                  <span>{current.executed ? "Investors can acknowledge demo allocations." : `${fmt(100000 - current.liquidity)} units remain outstanding; allocation is shared pro rata.`}</span>
                </div>
                <div className="quickbar-actions">
                  <Button onClick={() => setModal("replace")} icon={Settings2}>Change reserve</Button>
                  <Button icon={ShieldCheck} onClick={() => go("approvals")}>Open approvals</Button>
                </div>
              </div>
              <div className="desk-list-head">
                <h2>Investor requests</h2>
                <span>{rows.length} requests</span>
              </div>
              <div className="filter-tabs" role="group" aria-label="Filter investor requests">
                {[
                  { id: "all", label: "All requests", count: rows.length },
                  { id: "outstanding", label: "Outstanding", count: rows.filter((r) => r.outstanding > 0).length },
                  { id: "full", label: "Fully allocated", count: rows.filter((r) => r.outstanding === 0).length },
                ].map((item) => (
                  <button key={item.id} className={filter === item.id ? "selected" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                    {item.label}<span>{item.count}</span>
                  </button>
                ))}
              </div>
              <div className="toolbar desk-toolbar">
                <label className="search">
                  <Search size={17} />
                  <input aria-label="Search requests" placeholder="Search investor or request ID" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <div className="toolbar-actions">
                  <label className="filter">
                    <SlidersHorizontal size={15} />
                    <select aria-label="Filter requests" value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <option value="all">All requests</option>
                      <option value="outstanding">Has outstanding units</option>
                      <option value="full">Fully allocated</option>
                    </select>
                  </label>
                  <Button
                    icon={Download}
                    onClick={() =>
                      exportReport({
                        title: "Redemption request schedule",
                        state,
                        version: current.version,
                        allocations: filteredRequests,
                        events: [],
                      })
                    }
                  >
                    Export PDF
                  </Button>
                </div>
              </div>
              {table(filteredRequests)}
              <div className="table-note"><LockKeyhole size={14} /> Requests are frozen for this window. Batch approvals bind to the selected version.</div>
            </>
          )}

          {tab === "requests" && (
            <section>
              <div className="section-title">
                <div className="inline-heading">
                  <h2>Investor requests</h2>
                  <Badge>3 total</Badge>
                </div>
                <Badge tone="success">
                  <LockKeyhole size={12} />
                  Window frozen
                </Badge>
              </div>
              <div className="toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search requests"
                    placeholder="Search investor or request ID"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <label className="filter">
                  <SlidersHorizontal size={15} />
                  <select
                    aria-label="Filter requests"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All requests</option>
                    <option value="outstanding">Has outstanding units</option>
                    <option value="full">Fully allocated</option>
                  </select>
                </label>
              </div>
              {table(
                rows.filter(
                  (r) =>
                    `${r.name} ${r.id}`
                      .toLowerCase()
                      .includes(query.toLowerCase()) &&
                    (filter === "all" ||
                      (filter === "outstanding" && r.outstanding > 0) ||
                      (filter === "full" && r.outstanding === 0)),
                ),
                true,
              )}
              <div className="table-note">
                <LockKeyhole size={14} />
                Frozen requests cannot be edited in this window.
              </div>
            </section>
          )}

          {(tab === "batches" || tab === "approvals") && (
            <>
              <div className="batch-top">
                <div className="batch-id">
                  <span className="large-icon">
                    <Layers3 size={22} />
                  </span>
                  <div>
                    <h2>
                      Batch 01 <span>/</span> Version {version}
                    </h2>
                    <p>
                      Northstar Private Credit <span>/</span> September 2026
                    </p>
                  </div>
                </div>
                <div className="version-controls">
                  <button
                    className="icon-button"
                    aria-label="Previous version"
                    disabled={version === 1}
                    onClick={() => setVersion(version - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <select
                    aria-label="Batch version"
                    value={version}
                    onChange={(e) => setVersion(Number(e.target.value))}
                  >
                    {state.versions.map((b) => (
                      <option key={b.version} value={b.version}>
                        Version {b.version}
                        {b.version === state.active ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon-button"
                    aria-label="Next version"
                    disabled={version === state.active}
                    onClick={() => setVersion(version + 1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              {stale && (
                <div className="notice danger">
                  <AlertTriangle size={19} />
                  <div>
                    <strong>This batch has been superseded</strong>
                    <p>
                      These approvals belong to version {version}. Execution is
                      blocked. Version {state.active} requires fresh approval.
                    </p>
                  </div>
                  <Button onClick={() => setVersion(state.active)}>
                    Open current
                    <ArrowRight size={15} />
                  </Button>
                </div>
              )}
              {batch.executed && (
                <div className="notice success" role="status">
                  <CheckCircle2 size={20} />
                  <div>
                    <strong>Version {version} finalized in demo</strong>
                    <p>
                      {fmt(batch.liquidity)} units allocated across{" "}
                      {rows.filter((r) => r.allocated > 0).length} investors
                      {batch.finalizedAt ? ` at ${batch.finalizedAt}` : ""}.
                      Investor acknowledgments are available. No assets moved.
                    </p>
                  </div>
                  <Button onClick={() => go("activity")}>
                    View audit trail
                    <ArrowRight size={15} />
                  </Button>
                </div>
              )}
              {!stale && version > 1 && !batch.executed && (
                <div className="notice warning">
                  <History size={19} />
                  <div>
                    <strong>
                      {batch.approvals.length === 2
                        ? "Replacement batch reviewed."
                        : "Reserve changed. Fresh approval required."}
                    </strong>
                    <p>
                      {fmt(state.versions[version - 2].liquidity)} →{" "}
                      {fmt(batch.liquidity)} units. Earlier approvals and member
                      confirmations were not carried forward.
                    </p>
                  </div>
                </div>
              )}
              <div className="batch-layout">
                <section className="allocation-section">
                  <div className="section-title">
                    <h2>
                      {tab === "approvals"
                        ? "Approval scope"
                        : "Allocation preview"}
                    </h2>
                    <Badge
                      tone={
                        stale
                          ? "danger"
                          : batch.executed
                            ? "success"
                            : "warning"
                      }
                    >
                      {status(batch, state.active)}
                    </Badge>
                  </div>
                  <div className="batch-metrics">
                    <Metric label="Requested" value="100,000" />
                    <Metric
                      label="To allocate"
                      value={fmt(batch.liquidity)}
                      tone="sage-text"
                    />
                    <Metric
                      label="Fulfillment"
                      value={`${percent}%`}
                      suffix=""
                    />
                  </div>
                  {table(rows)}
                  <div className="allocation-explanation">
                    <Fingerprint size={19} />
                    <div>
                      <h3>Same rule. Every investor.</h3>
                      <p>
                        Pro-rata allocation, rounded to whole units. Remainders
                        resolve by request sequence. This preview is simulated,
                        not a ledger proof.
                      </p>
                    </div>
                  </div>
                  <div className="batch-footer">
                    <span className="mono">DEMO-BATCH-01-V{version}</span>
                    <Button
                      icon={Settings2}
                      disabled={stale || batch.executed}
                      onClick={() => {
                        setReserve(batch.liquidity === 40000 ? 50000 : 40000);
                        setModal("replace");
                      }}
                    >
                      Simulate reserve change
                    </Button>
                  </div>
                </section>
                <aside className="review-panel">
                  <div className="section-title">
                    <h2>Approval checkpoint</h2>
                    <ShieldCheck size={20} />
                  </div>
                  <p className="panel-intro">
                    Bound to batch 01, version {version}.
                  </p>
                  <div className="review-group">
                    <span className="group-label">Business review</span>
                    {[
                      {
                        role: "fund",
                        name: "Fund reviewer",
                        person: "Maya Chen",
                        initials: "MC",
                        avatar: "/reviewer-maya.png",
                      },
                      {
                        role: "treasury",
                        name: "Treasury reviewer",
                        person: "Daniel Reed",
                        initials: "DR",
                        avatar: "/reviewer-daniel.png",
                      },
                    ].map((r) => (
                      <div className="reviewer" key={r.role}>
                        <span
                          className={`review-avatar ${batch.approvals.includes(r.role) ? "approved" : ""}`}
                        >
                          <img src={r.avatar} alt="" />
                          {batch.approvals.includes(r.role) && (
                            <span className="review-avatar-check"><Check size={12} /></span>
                          )}
                        </span>
                        <div>
                          <strong>{r.name}</strong>
                          <small>{r.person}</small>
                        </div>
                        <button
                          className={`review-button ${batch.approvals.includes(r.role) ? "approved" : ""}`}
                          disabled={
                            stale ||
                            batch.executed ||
                            batch.approvals.includes(r.role)
                          }
                          onClick={() => setModal({ kind: "approve", ...r })}
                        >
                          {batch.approvals.includes(r.role)
                            ? "Approved"
                            : "Review"}
                          {!batch.approvals.includes(r.role) && (
                            <ChevronRight size={13} />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="review-group">
                    <div className="section-title">
                      <span className="group-label">BitSafe confirmation</span>
                      <span className="mono">
                        {batch.confirmations.length}/2
                      </span>
                    </div>
                    <div className="members">
                      {["A", "B", "C"].map((m) => (
                        <button
                          key={m}
                          title={`Simulate member ${m} confirmation`}
                          aria-label={`Confirm as member ${m}`}
                          disabled={
                            stale ||
                            batch.executed ||
                            batch.approvals.length < 2 ||
                            batch.confirmations.includes(m)
                          }
                          className={
                            batch.confirmations.includes(m) ? "confirmed" : ""
                          }
                          onClick={() =>
                            setModal({ kind: "confirm", member: m })
                          }
                        >
                          {batch.confirmations.includes(m) ? (
                            <Check size={14} />
                          ) : (
                            <Users size={14} />
                          )}
                          Member {m}
                        </button>
                      ))}
                    </div>
                    <p className="small-muted">
                      Two member confirmations, after both business reviews.
                    </p>
                  </div>
                  <div className="execution">
                    <div
                      className={
                        ready || batch.executed ? "sage-text" : "muted"
                      }
                    >
                      {batch.executed ? (
                        <CheckCircle2 size={16} />
                      ) : (
                        <LockKeyhole size={16} />
                      )}
                      <span>
                        {batch.executed
                          ? "Finalized in demo"
                          : stale
                            ? "Stale execution blocked"
                            : ready
                              ? "Ready to finalize"
                              : "Waiting for authorization"}
                      </span>
                    </div>
                    <Button
                      className="primary full"
                      icon={batch.executed ? CheckCheck : ShieldCheck}
                      disabled={!ready}
                      onClick={() => setModal("execute")}
                    >
                      {batch.executed
                        ? "Batch finalized"
                        : "Finalize demo batch"}
                    </Button>
                    <small>Simulation only. No ledger write or payment.</small>
                  </div>
                </aside>
              </div>
            </>
          )}

          {tab === "activity" && (
            <section>
              <div className="toolbar">
                <div className="inline-heading">
                  <h2>Window history</h2>
                  <Badge>{state.events.length} events</Badge>
                </div>
                <label className="filter">
                  <SlidersHorizontal size={15} />
                  <select
                    aria-label="Filter activity"
                    value={activityFilter}
                    onChange={(e) => setActivityFilter(e.target.value)}
                  >
                    <option value="all">All activity</option>
                    <option value="approve">Business approvals</option>
                    <option value="replace">Batch changes</option>
                    <option value="execute">Finalization</option>
                  </select>
                </label>
              </div>
              <div className="activity-feed">
                {state.events
                  .filter(
                    (e) =>
                      activityFilter === "all" || e.type === activityFilter,
                  )
                  .map((e) => {
                    const EventIcon =
                      e.type === "approve"
                        ? ShieldCheck
                        : e.type === "replace"
                          ? History
                          : e.type === "request"
                            ? Users
                            : e.type === "confirm"
                              ? CheckCheck
                              : FileCheck2;
                    return (
                      <article className={`activity-card ${e.type}`} key={e.id}>
                        <span className="activity-card-icon"><EventIcon size={18} /></span>
                        <div className="activity-card-body">
                          <div className="activity-card-meta">
                            <span className={`activity-kind ${e.type}`}>
                              {activityKinds[e.type] || "Activity"}
                            </span>
                            <span className="activity-version">Batch 01 · Version {e.version ?? state.active}</span>
                            <time>{e.time}</time>
                          </div>
                          <h3>{e.title}</h3>
                          <p>{e.detail}</p>
                          <div className="activity-card-footer">
                            <span>{e.actor || "Fund operations"}</span>
                            <span className="activity-demo-label">Local demo record</span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                {!state.events.some(
                  (e) => activityFilter === "all" || e.type === activityFilter,
                ) && (
                  <div className="empty">
                    <History size={25} />
                    <h3>No events in this category</h3>
                    <p>
                      {activityFilter === "approve"
                        ? "Fund and treasury approvals will appear here after a reviewer approves a batch."
                        : activityFilter === "replace"
                          ? "Reserve changes will appear here when a replacement batch is created."
                          : activityFilter === "execute"
                            ? "Finalization appears after both reviewer roles and the member threshold are satisfied."
                            : "Window activity will appear here as requests and decisions are recorded."}
                    </p>
                    <div className="empty-actions">
                      <Button
                        onClick={() => {
                          setVersion(state.active);
                          go(
                            activityFilter === "replace"
                              ? "batches"
                              : "approvals",
                          );
                        }}
                      >
                        Open{" "}
                        {activityFilter === "replace" ? "batch" : "approvals"}
                        <ArrowRight size={15} />
                      </Button>
                      <Button
                        className="quiet"
                        onClick={() => setActivityFilter("all")}
                      >
                        Show all activity
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === "live" && <LiveLedger notify={announce} />}

          {persona === "investor" && tab !== "live" &&
            (() => {
              const r = allocate(investors, current.liquidity)[0];
              const claimed = current.claimed.includes(r.id);
              return (
                <section className="investor-view">
                  <div className="investor-banner">
                    <Avatar person={r} />
                    <div>
                      <h2>{r.name}</h2>
                      <p>{r.id} / September redemption</p>
                    </div>
                    <Badge tone={current.executed ? "success" : "warning"}>
                      {current.executed ? "Allocation finalized" : "In review"}
                    </Badge>
                  </div>
                  <div className="metrics">
                    <Metric label="Requested" value={fmt(r.units)} />
                    <Metric
                      label={
                        current.executed ? "Allocated" : "Proposed allocation"
                      }
                      value={fmt(r.allocated)}
                      tone="sage-text"
                    />
                    <Metric
                      label="Outstanding"
                      value={fmt(r.outstanding)}
                      tone="gold-text"
                    />
                  </div>
                  <section className="next-window-request">
                    <div>
                      <span className="eyebrow">NEXT REDEMPTION WINDOW</span>
                      <h3>
                        {nextWindowRequest
                          ? "Request submitted"
                          : "Request an allocation"}
                      </h3>
                      <p>
                        {nextWindowRequest
                          ? `Your request for ${fmt(nextWindowRequest.units)} units is recorded in this local demo.`
                          : "The September window is closed. Submit a request for the next window; it will not change the frozen current batch."}
                      </p>
                    </div>
                    <Button
                      className={nextWindowRequest ? "quiet" : "primary"}
                      icon={nextWindowRequest ? Settings2 : Plus}
                      onClick={() => {
                        setRequestAmount(nextWindowRequest?.units ?? r.units);
                        setRequestError("");
                        setModal("request");
                      }}
                    >
                      {nextWindowRequest ? "Edit request" : "Request allocation"}
                    </Button>
                  </section>
                  <div className="receipt">
                    <FileCheck2 size={32} />
                    <h2>
                      {claimed
                        ? "Allocation acknowledged"
                        : "Your allocation receipt"}
                    </h2>
                    <p>
                      {claimed
                        ? "Your acknowledgment is recorded. Download the demo receipt below."
                        : current.executed && r.allocated === 0
                          ? "No units were allocated in this batch. Your full request remains outstanding; there is no receipt to acknowledge."
                          : current.executed
                            ? "Acknowledge your demo allocation. This does not transfer assets or settle the outstanding amount."
                            : "Your allocation is awaiting business review and member confirmation."}
                    </p>
                    <Button
                      className="primary"
                      disabled={
                        !current.executed || claimed || r.allocated === 0
                      }
                      icon={Check}
                      onClick={() => {
                        setVersion(state.active);
                        setModal("claim");
                      }}
                    >
                      {claimed ? "Acknowledged" : "Acknowledge demo allocation"}
                    </Button>
                    {claimed && (
                      <Button
                        icon={Download}
                        onClick={() =>
                          exportReport({
                            title: "Investor allocation statement",
                            state,
                            version: current.version,
                            allocations: [r],
                            events: [],
                            investor: r,
                          })
                        }
                      >
                        Download PDF receipt
                      </Button>
                    )}
                  </div>
                  <p className="table-note">
                    <LockKeyhole size={14} />
                    Demo perspective only. This view is not an authenticated
                    privacy boundary.
                  </p>
                </section>
              );
            })()}
        </div>
        <footer>
          <span>
            <img className="footer-mark-img" src="/alluvren-mark.png" alt="" /> Alluvren{" "}
            <span className="footer-sep">/</span> Private redemption desk
          </span>
          <button onClick={() => setModal("connection")}>
            <span
              className={`status-dot ${connection.phase === "connected" ? "" : "neutral"}`}
            />
            {connection.phase === "connected"
              ? "Read-only evidence connected"
              : connection.phase === "loading"
                ? "Evidence refreshing"
                : connection.snapshot
                  ? "Evidence needs refresh"
                  : connection.phase === "error"
                    ? "Evidence unavailable"
                    : "Local demo"}
            <ArrowUpRight size={13} />
          </button>
        </footer>
      </main>

      {selected && (
        <Modal
          drawer
          title="Request details"
          onClose={() => setSelected(null)}
          feedback={feedback}
        >
          <div className="investor detail-investor">
            <Avatar person={selected} />
            <h3>{selected.name}</h3>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Request</dt>
              <dd className="mono">{selected.id}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{fmt(selected.units)} units</dd>
            </div>
            <div>
              <dt>Allocated in v{batch.version}</dt>
              <dd>{fmt(selected.allocated)} units</dd>
            </div>
            <div>
              <dt>Outstanding</dt>
              <dd>{fmt(selected.outstanding)} units</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>Simulated demo</dd>
            </div>
          </dl>
          <Button className="primary full" onClick={() => setSelected(null)}>
            Done
          </Button>
        </Modal>
      )}
      {modal && (
        <Modal
          feedback={feedback}
          title={
            typeof modal === "object"
              ? modal.kind === "approve"
                ? `${modal.name} approval`
                : `Member ${modal.member} confirmation`
              : {
                  replace: "Create a replacement batch",
                  execute: "Finalize demo batch",
                  connection: "Governance connection",
                  help: "About this workspace",
                  persona: "Demo perspective",
                  reset: "Reset this demo?",
                  claim: "Acknowledge allocation",
                  request: "Request an allocation",
                }[modal]
          }
          onClose={() => setModal(null)}
        >
          {actionError && (
            <div className="connection-issue danger" role="alert">
              <strong>This action could not be completed</strong>
              <p>{actionError}</p>
              <p>Return to the current batch to review its requirements.</p>
              <Button
                onClick={() => {
                  setVersion(state.active);
                  go("batches");
                  setModal(null);
                }}
              >
                Return to current batch
              </Button>
            </div>
          )}
          {modal === "replace" && (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const value = Number(reserve);
                if (
                  String(reserve).trim() === "" ||
                  !Number.isSafeInteger(value) ||
                  value < 0 ||
                  value > 100000
                ) {
                  setReserveError(
                    "The reserve must be a whole number from 0 to 100,000. Enter a valid amount to create this batch.",
                  );
                  return;
                }
                if (value === batch.liquidity) {
                  setReserveError(
                    "This matches the current reserve. Enter a different amount, or close this dialog to keep the current batch.",
                  );
                  return;
                }
                act("replace", { liquidity: Number(reserve) });
              }}
            >
              <p className="modal-copy">
                Create version {state.active + 1} with a new demo reserve. Prior
                approvals stay with their original version and cannot authorize
                this replacement.
              </p>
              <label className="field">
                Available reserve (whole units)
                <input
                  required
                  type="number"
                  min="0"
                  max="100000"
                  step="1"
                  value={reserve}
                  aria-invalid={!!reserveError}
                  aria-describedby={reserveError ? "reserve-error" : undefined}
                  onChange={(e) => {
                    setReserve(e.target.value);
                    setReserveError("");
                    setActionError(null);
                  }}
                />
              </label>
              {reserveError && (
                <p id="reserve-error" className="field-error" role="alert">
                  <AlertTriangle size={15} />
                  {reserveError}
                </p>
              )}
              <div className="change-preview">
                <span>Fulfillment</span>
                <strong>
                  {percent}%<ArrowRight size={16} />
                  {String(reserve).trim() !== "" &&
                  Number.isSafeInteger(Number(reserve)) &&
                  Number(reserve) >= 0 &&
                  Number(reserve) <= 100000
                    ? `${Math.round(Number(reserve) / 1000)}%`
                    : "—"}
                </strong>
              </div>
              <p className="small-muted">
                This simulates a replacement. It does not mutate a frozen ledger
                contract.
              </p>
              <Button className="primary full" icon={Plus}>
                Create demo version {state.active + 1}
              </Button>
            </form>
          )}
          {typeof modal === "object" && modal.kind === "approve" && (
            <>
              <p className="modal-copy">
                Simulate {modal.person}'s approval of batch 01, version{" "}
                {version}. The allocated amount is{" "}
                <strong>{fmt(batch.liquidity)} units</strong>.
              </p>
              <div className="notice warning">
                <Fingerprint size={20} />
                <p>
                  This approval is valid only for this version. A replacement
                  needs a new review.
                </p>
              </div>
              <Button
                className="primary full"
                icon={Check}
                onClick={() => act("approve", { role: modal.role })}
              >
                Approve as {modal.name.toLowerCase()} (demo)
              </Button>
            </>
          )}
          {typeof modal === "object" && modal.kind === "confirm" && (
            <>
              <p className="modal-copy">
                Simulate member {modal.member}'s confirmation of version{" "}
                {version}, separate from the fund and treasury approvals.
              </p>
              <Button
                className="primary full"
                icon={Check}
                onClick={() => act("confirm", { member: modal.member })}
              >
                Confirm in demo
              </Button>
            </>
          )}
          {modal === "execute" && (
            <>
              <p className="modal-copy">
                Finalize version {version} with {fmt(batch.liquidity)} allocated
                units. Both business roles and at least two demo members have
                approved.
              </p>
              <div className="notice warning">
                <AlertTriangle size={20} />
                <p>No Canton command will be sent and no assets will move.</p>
              </div>
              <Button
                className="primary full"
                icon={ShieldCheck}
                onClick={() => act("execute")}
              >
                Finalize in demo
              </Button>
            </>
          )}
          {modal === "reset" && (
            <>
              <p className="modal-copy">
                Remove this session's simulated approvals, versions and
                receipts. No ledger data will be changed.
              </p>
              <Button
                className="primary full"
                icon={RefreshCw}
                onClick={() => {
                  setState(initialState());
                  setVersion(1);
                  setQuery("");
                  setFilter("all");
                  setActivityFilter("all");
                  setNextWindowRequest(null);
                  setRequestAmount(60000);
                  setModal(null);
                  announce("Demo reset");
                }}
              >
                Reset demo
              </Button>
            </>
          )}
          {modal === "claim" && (
            <>
              <p className="modal-copy">
                Acknowledge Aster Capital's allocation of{" "}
                {fmt(allocate(investors, current.liquidity)[0].allocated)} units
                in version {current.version}. This is a demo receipt, not
                payment.
              </p>
              <Button
                className="primary full"
                icon={Check}
                onClick={() =>
                  act("claim", { investor: "REQ-001", version: state.active })
                }
              >
                Acknowledge in demo
              </Button>
            </>
          )}
          {modal === "request" && (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const units = Number(requestAmount);
                if (!Number.isSafeInteger(units) || units < 1 || units > 1000000) {
                  setRequestError("Enter a whole number from 1 to 1,000,000 units.");
                  return;
                }
                setNextWindowRequest({ units });
                setModal(null);
                announce("Next-window allocation request recorded in demo.");
              }}
            >
              <p className="modal-copy">
                Submit a simulated request for the next redemption window. The
                current September batch is frozen and will not be changed.
              </p>
              <label className="field">
                Requested units
                <input
                  autoFocus
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  value={requestAmount}
                  aria-invalid={!!requestError}
                  aria-describedby={requestError ? "request-error" : undefined}
                  onChange={(event) => {
                    setRequestAmount(event.target.value);
                    setRequestError("");
                  }}
                />
              </label>
              {requestError && (
                <p id="request-error" className="field-error" role="alert">
                  <AlertTriangle size={15} /> {requestError}
                </p>
              )}
              <div className="notice warning">
                <Info size={19} />
                <p>Demo only. This does not submit to Canton or move assets.</p>
              </div>
              <Button className="primary full" icon={Check}>
                Submit demo request
              </Button>
            </form>
          )}
          {modal === "persona" && (
            <>
              <p className="modal-copy">
                Switch the simulated perspective. This does not sign in as
                another user or change ledger permissions.
              </p>
              <div className="perspectives">
                {[
                  {
                    key: "operator",
                    title: "Fund operator",
                    subtitle: "Requests, allocations and reviews",
                    icon: LayoutDashboard,
                  },
                  {
                    key: "investor",
                    title: "Aster Capital",
                    subtitle: "Own allocation and demo receipt",
                    icon: Wallet,
                  },
                ].map((p) => (
                  <button
                    key={p.key}
                    onClick={() => {
                      setPersona(p.key);
                      go(p.key === "operator" ? "desk" : "investor");
                      setModal(null);
                    }}
                  >
                    <p.icon size={22} />
                    <span>
                      <strong>{p.title}</strong>
                      <small>{p.subtitle}</small>
                    </span>
                    {persona === p.key ? (
                      <Check size={18} />
                    ) : (
                      <ChevronRight size={18} />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          {modal === "help" && (
            <>
              <p className="modal-copy">
                One fund, one redemption window, three sample investors.
                Alluvren previews a deterministic allocation and demonstrates
                version-bound approvals.
              </p>
              <ul className="help-list">
                <li>Fund and treasury review are separate roles.</li>
                <li>Two member confirmations follow business review.</li>
                <li>Replacing a batch requires fresh authorization.</li>
                <li>Finalization and receipts here are browser simulations.</li>
              </ul>
              <p className="small-muted">
                Live governance evidence is read-only. The app cannot start the
                VM or submit governance commands.
              </p>
              <Button className="primary full" onClick={() => setModal(null)}>
                Back to desk
              </Button>
            </>
          )}
          {modal === "connection" && (
            <ConnectionPanel
              connection={connection}
              onRefresh={checkConnection}
              onCancel={cancelConnection}
            />
          )}
        </Modal>
      )}
      {!modal && !selected && feedback}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
