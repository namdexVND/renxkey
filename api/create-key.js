import crypto from "crypto";

const DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
const FIREBASE_AUTH = process.env.FIREBASE_AUTH || "";
const LINK4M_TOKEN = process.env.LINK4M_API_TOKEN || "";
const CLAIM_PAGE_URL = process.env.CLAIM_PAGE_URL || "https://namdexvnd.github.io/VNDhubKEY/";

const DEFAULT_DURATION_SEC = 8 * 3600; // Mặc định 8 giờ

const DURATIONS_SEC = {
  normal: DEFAULT_DURATION_SEC,
  day: DEFAULT_DURATION_SEC,
  week: DEFAULT_DURATION_SEC,
  month: DEFAULT_DURATION_SEC,
  vip: DEFAULT_DURATION_SEC
};

function makeKey(suffix = "") {
  const cleanSuffix = String(suffix || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");

  if (cleanSuffix) {
    return `RENX_${cleanSuffix}`;
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(12);
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `RENX_${code}`;
}

function buildDbUrl(path) {
  const query = FIREBASE_AUTH ? `?auth=${encodeURIComponent(FIREBASE_AUTH)}` : "";
  return `${DB_URL}/${path}.json${query}`;
}

async function shortenWithLink4M(targetUrl) {
  if (!LINK4M_TOKEN) {
    return { shortenedUrl: targetUrl, shortened: false };
  }

  const apiUrl =
    `https://link4m.co/api-shorten/v2?api=${encodeURIComponent(LINK4M_TOKEN)}` +
    `&url=${encodeURIComponent(targetUrl)}`;

  const res = await fetch(apiUrl);
  const data = await res.json();

  if (res.ok && data && data.status === "success" && typeof data.shortenedUrl === "string" && data.shortenedUrl) {
    return { shortenedUrl: data.shortenedUrl, shortened: true };
  }

  return { shortenedUrl: targetUrl, shortened: false };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!DB_URL) {
    return res.status(500).json({ ok: false, error: "Missing FIREBASE_DB_URL env" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const type = "normal";
    const durationSec = DURATIONS_SEC[body.type] ?? DEFAULT_DURATION_SEC;
    const key = makeKey(body.suffix || "");
    const keyId = key.replace(/[^a-zA-Z0-9_]/g, "_");
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Kiểm tra trùng key trên Firebase
    const checkRes = await fetch(buildDbUrl(`keys/${keyId}`));
    const existing = await checkRes.json();
    if (existing && typeof existing === "object") {
      return res.status(409).json({ ok: false, error: "Key đã tồn tại" });
    }

    // 2. Tạo key rỗng chủ trên Firebase (mặc định 8h)
    const payload = {
      key,
      userId: "",
      type,
      expireAt: nowSec + durationSec,
      created: new Date().toLocaleDateString("vi-VN")
    };

    const writeRes = await fetch(buildDbUrl(`keys/${keyId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!writeRes.ok) {
      return res.status(502).json({ ok: false, error: "Không ghi được key lên Firebase" });
    }

    // 3. Tạo link đích và rút gọn qua Link4M ở phía server
    const joiner = CLAIM_PAGE_URL.includes("?") ? "&" : "?";
    const targetUrl = `${CLAIM_PAGE_URL}${joiner}key=${encodeURIComponent(key)}`;
    const linkInfo = await shortenWithLink4M(targetUrl);

    return res.status(200).json({
      ok: true,
      key: payload.key,
      type: payload.type,
      durationHours: durationSec / 3600,
      expireAt: payload.expireAt,
      targetUrl,
      shortenedUrl: linkInfo.shortenedUrl,
      shortened: linkInfo.shortened
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Lỗi máy chủ khi tạo key và link 4M" });
  }
    }
