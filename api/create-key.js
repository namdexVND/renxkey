import crypto from "crypto";

const DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
const FIREBASE_AUTH = (process.env.FIREBASE_AUTH || "").trim();
const LINK4M_TOKEN = (process.env.LINK4M_API_TOKEN || "").trim();
const CLAIM_PAGE_URL = (process.env.CLAIM_PAGE_URL || "https://namdexvnd.github.io/VNDhubKEY/").trim();

const DEFAULT_DURATION_SEC = 8 * 3600; // Mặc định 8 giờ

const DURATIONS_SEC = {
  normal: DEFAULT_DURATION_SEC,
  day: DEFAULT_DURATION_SEC,
  week: DEFAULT_DURATION_SEC,
  month: DEFAULT_DURATION_SEC,
  vip: DEFAULT_DURATION_SEC
};

function makeKey(suffix = "") {
  let rawSuffix = String(suffix || "").trim().toUpperCase();
  if (rawSuffix.startsWith("RENX_")) {
    rawSuffix = rawSuffix.slice(5);
  }

  const cleanSuffix = rawSuffix.replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
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

function buildTargetUrl(key) {
  const baseUrl = CLAIM_PAGE_URL || "https://namdexvnd.github.io/VNDhubKEY/";
  const joiner = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${joiner}ma=${encodeURIComponent(key)}`;
}

async function shortenWithLink4M(targetUrl) {
  if (!LINK4M_TOKEN) {
    return {
      shortenedUrl: targetUrl,
      shortened: false,
      reason: "MISSING_LINK4M_API_TOKEN"
    };
  }

  const apiUrl =
    `https://link4m.com/api-shorten/v2?api=${encodeURIComponent(LINK4M_TOKEN)}` +
    `&url=${encodeURIComponent(targetUrl)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(apiUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Accept": "application/json, text/plain, */*"
      }
    });
    clearTimeout(timer);

    const rawText = await res.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }

    const shortUrl =
      data?.shortenedUrl ||
      data?.short_url ||
      data?.shortened_url ||
      data?.url ||
      data?.data?.shortenedUrl ||
      data?.data?.short_url ||
      "";

    const isSuccess =
      res.ok &&
      data &&
      (data.status === "success" || data.success === true || data.error === 0) &&
      typeof shortUrl === "string" &&
      /^https?:\/\//i.test(shortUrl.trim());

    if (isSuccess) {
      return {
        shortenedUrl: shortUrl.trim(),
        shortened: true,
        reason: "OK"
      };
    }

    let reason = "LINK4M_API_FAILED";
    if (data && (data.message || data.msg || data.error)) {
      reason = String(data.message || data.msg || data.error);
    } else if (!res.ok) {
      reason = `HTTP_${res.status}`;
    }

    return {
      shortenedUrl: targetUrl,
      shortened: false,
      reason
    };
  } catch (err) {
    return {
      shortenedUrl: targetUrl,
      shortened: false,
      reason: err?.name === "AbortError" ? "LINK4M_TIMEOUT" : "LINK4M_FETCH_ERROR"
    };
  }
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

    // 1. Kiểm tra key trên Firebase: nếu chưa có thì mới tạo rỗng chủ (8h)
    const checkRes = await fetch(buildDbUrl(`keys/${keyId}`));
    const existing = checkRes.ok ? await checkRes.json() : null;

    let finalPayload = {
      key,
      userId: "",
      type,
      expireAt: nowSec + durationSec,
      created: new Date().toLocaleDateString("vi-VN")
    };

    if (!existing || typeof existing !== "object") {
      const writeRes = await fetch(buildDbUrl(`keys/${keyId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload)
      });

      if (!writeRes.ok) {
        return res.status(502).json({ ok: false, error: "Không ghi được key lên Firebase" });
      }
    } else {
      finalPayload = { ...finalPayload, ...existing, key };
    }

    // 2. Tạo link đích ?ma=... và rút gọn qua Link4M ở phía server
    const targetUrl = buildTargetUrl(key);
    const linkInfo = await shortenWithLink4M(targetUrl);

    return res.status(200).json({
      ok: true,
      key: finalPayload.key,
      type: finalPayload.type,
      durationHours: durationSec / 3600,
      expireAt: finalPayload.expireAt,
      targetUrl,
      shortenedUrl: linkInfo.shortenedUrl,
      shortened: linkInfo.shortened,
      linkReason: linkInfo.reason
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Lỗi máy chủ khi tạo key và link 4M" });
  }
}
