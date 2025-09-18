// src/utils/analytics.js
// Lightweight, zero-dependency analytics used only in the browser.
// Stores the last 1000 events in localStorage and lets you download them as CSV.

const KEY = "mbs_logs_v1";

export function logAnalysisEvent(kind, payload = {}) {
  if (typeof window === "undefined") return; // no-op on server
  try {
    const now = new Date().toISOString();
    const entry = { t: now, kind, ...payload };
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    arr.push(entry);
    if (arr.length > 1000) arr.splice(0, arr.length - 1000);
    localStorage.setItem(KEY, JSON.stringify(arr));
    // Helpful while debugging:
    // console.info("[analytics]", entry);
  } catch {
    // swallow
  }
}

export function getLogs() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function downloadLogsCSV(filename = "analysis-logs.csv") {
  if (typeof window === "undefined") return;
  const rows = getLogs();
  if (!rows.length) {
    alert("No logs yet.");
    return;
  }
  const headers = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      headers
        .map((h) => JSON.stringify(r[h] ?? "")) // quote + escape
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}
