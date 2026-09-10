// ==========================================================
// TokenScore — CoinMarketCap Proxy (Netlify Function)
// ----------------------------------------------------------
// เหตุผลที่ต้องมีไฟล์นี้: API ของ CoinMarketCap บล็อกการเรียก
// จากเบราว์เซอร์โดยตรง (CORS) เพื่อปกป้อง API key — จึงต้องมี
// serverless function เป็นคนกลาง โดยคีย์ถูกเก็บใน Netlify
// Environment variable (CMC_API_KEY) เท่านั้น ไม่ผ่านเบราว์เซอร์
//
// วิธีเปิดใช้ (ครั้งเดียว):
//   1. สมัครคีย์ฟรีที่ https://coinmarketcap.com/api (Basic 10,000 credits/เดือน)
//   2. Netlify → Site configuration → Environment variables
//      → เพิ่ม key ชื่อ CMC_API_KEY (ค่า = คีย์ของคุณ)
//   3. Deploys → Trigger deploy (Redeploy) เพื่อให้ค่าใหม่มีผล
// ==========================================================

const ALLOWED_PATHS = new Set([
  '/v1/cryptocurrency/listings/latest',
  '/v1/global-metrics/quotes/latest',
  '/v2/tools/price-conversion'
]);

const CACHE_MS = 60 * 1000;          // แคชในหน่วยความจำ 60 วินาที (ประหยัด credits)
const RATE_MAX = 30;                 // จำกัด ~30 คำขอ/IP/นาที (กันเว็บอื่นมายิง function นี้)
const cache = new Map();             // url → { ts, body }
const hits = new Map();              // ip → { n, reset }

function json(status, body, raw){
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: raw ? body : JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  const key = process.env.CMC_API_KEY;
  if (!key){
    return json(503, { error: 'no-key', message: 'ยังไม่ได้ตั้งค่า CMC_API_KEY ใน Netlify (Site configuration → Environment variables)' });
  }
  if (event.httpMethod && event.httpMethod !== 'GET'){
    return json(405, { error: 'method-not-allowed' });
  }

  const path = (event.queryStringParameters && event.queryStringParameters.path) || '';
  if (!ALLOWED_PATHS.has(path)){
    return json(400, { error: 'forbidden-path', message: 'endpoint นี้ไม่อยู่ใน whitelist ของ TokenScore' });
  }

  // rate limit แบบ best-effort (ต่อ instance)
  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || 'anon';
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset){ h = { n: 0, reset: now + 60000 }; hits.set(ip, h); }
  h.n++;
  if (hits.size > 5000) hits.clear();
  if (h.n > RATE_MAX) return json(429, { error: 'rate-limited' });

  // สร้าง URL ไปยัง CMC (ส่งต่อ query params ทั้งหมดยกเว้น path)
  const params = { ...(event.queryStringParameters || {}) };
  delete params.path;
  const qs = new URLSearchParams(params).toString();
  const url = 'https://pro-api.coinmarketcap.com' + path + (qs ? '?' + qs : '');

  // ตรวจแคชก่อนยิง CMC
  const hit = cache.get(url);
  if (hit && now - hit.ts < CACHE_MS) return json(200, hit.body, true);

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-CMC_PRO_API_KEY': key }
    });
    const body = await res.text();
    if (!res.ok){
      // ไม่ส่งคีย์/ข้อความ CMC กลับไปที่เบราว์เซอร์ — ส่งเฉพาะสถานะ
      return json(res.status === 401 ? 502 : res.status, { error: 'cmc-error', status: res.status });
    }
    cache.set(url, { ts: now, body });
    if (cache.size > 50) cache.clear();
    return json(200, body, true);   // ส่งต่อ JSON ของ CMC ตรง ๆ
  } catch(e){
    return json(502, { error: 'upstream-error', message: String((e && e.message) || e) });
  }
};
