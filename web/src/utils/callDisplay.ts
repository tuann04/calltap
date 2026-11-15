import type { CallMetadata } from "../types";

const SERVICE_LABELS: Record<string, string> = {
  sesame: "Sesame",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  "gemini-studio": "AI Studio",
  hume: "Hume",
  elevenlabs: "ElevenLabs",
  vapi: "Vapi",
  retell: "Retell",
};

export function extractHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

export function formatServiceLabel(service: string, pageUrl?: string | null): string {
  const key = (service || "").toLowerCase().trim();
  if (key && key !== "unknown" && key !== "generic" && key !== "custom") {
    return SERVICE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
  }
  const host = extractHostname(pageUrl);
  if (host) return host;
  if (key === "custom") return "Custom Call";
  return "Unknown Site";
}

function cleanPageContext(pageTitle: string | null | undefined, label: string): string | null {
  if (!pageTitle) return null;
  let cleaned = pageTitle.trim();
  if (!cleaned) return null;

  // Strip common site suffixes/prefixes like "ChatGPT - New chat" or "Maya | Sesame"
  const noise = [
    /\s*[-|—·]\s*(chatgpt|openai|sesame|gemini|google ai studio|hume|elevenlabs)\s*$/i,
    /^(chatgpt|sesame|gemini|google ai studio)\s*[-|—·]\s*/i,
  ];
  for (const re of noise) {
    cleaned = cleaned.replace(re, "").trim();
  }

  const lower = cleaned.toLowerCase();
  const labelLower = label.toLowerCase();
  if (
    !cleaned ||
    lower === labelLower ||
    lower === "new chat" ||
    lower === "sesame ai" ||
    lower === "google gemini"
  ) {
    return null;
  }
  return cleaned;
}

export function formatShortTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today, ${time}`;

  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}

export function formatCallTitle(call: CallMetadata): string {
  const custom = call.title.trim();
  if (custom) return custom;

  const label = formatServiceLabel(call.service, call.page_url);
  const ctx = cleanPageContext(call.page_title, label);
  const when = formatShortTimestamp(call.started_at);

  if (ctx) {
    const shortCtx = ctx.length > 36 ? `${ctx.slice(0, 35).trimEnd()}…` : ctx;
    return `${label} · ${shortCtx} · ${when}`;
  }
  return `${label} · ${when}`;
}
