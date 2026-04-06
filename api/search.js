// api/search.js - Vercel Serverless Function
// ✅ 2단계 방식: 1단계 웹검색 → 2단계 JSON 구조화 (안정적)
// ✅ 네이버 플레이스 기준 별점 높은 순 15개 반환

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW; }
  record.count++;
  rateLimit.set(ip, record);
  return record.count <= RATE_LIMIT_MAX;
}

async function callOpenAI(apiKey, body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(msg);
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: '요청이 너무 많아요. 1분 후 다시 시도해주세요.' });

  const { region } = req.body || {};
  if (!region || typeof region !== 'string' || !region.trim()) return res.status(400).json({ error: '지역명을 입력해주세요.' });
  if (region.length > 50) return res.status(400).json({ error: '지역명이 너무 길어요.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '서버 설정 오류입니다.' });

  const q = region.trim();

  try {
    // ── 1단계: 웹 검색으로 맛집 정보 수집 ──────────────────────────────
    const searchData = await callOpenAI(apiKey, {
      model: 'gpt-4o-mini-search-preview',
      web_search_options: {},
      messages: [
        {
          role: 'system',
          content: `네이버 플레이스(place.naver.com)에서 "${q}" 맛집을 검색해서 별점 높은 순으로 식당 정보를 수집하세요. 각 식당의 이름, 음식 종류, 대표 메뉴, 주소, 별점, 리뷰 수를 최대한 자세히 알려주세요.`
        },
        {
          role: 'user',
          content: `"${q}" 주변 맛집을 네이버 플레이스에서 별점 높은 순으로 15개 찾아주세요.`
        }
      ]
    });

    const rawText = searchData.choices?.[0]?.message?.content || '';
    if (!rawText) throw new Error('검색 결과를 가져오지 못했어요. 다시 시도해주세요.');

    // ── 2단계: 검색 결과를 JSON으로 구조화 ─────────────────────────────
    const structureData = await callOpenAI(apiKey, {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `아래 맛집 검색 결과 텍스트를 분석해서 반드시 다음 JSON 형식으로만 변환하세요.
별점 높은 순으로 정렬하고, 정보가 없는 필드는 빈 문자열("")로 채우세요.
반드시 "restaurants" 키를 최상위에 사용하세요.

{"restaurants":[{"name":"식당명","category":"음식카테고리","menu":"대표메뉴2-3가지","address":"주소","rating":"별점(예:4.7)","reviews":"리뷰수(예:1,203)","naverUrl":"네이버플레이스URL(없으면 빈문자열)"}]}`
        },
        {
          role: 'user',
          content: rawText
        }
      ]
    });

    const jsonText = structureData.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('결과 변환에 실패했어요. 다시 시도해주세요.');
    }

    // restaurants 키가 없을 경우 다른 키도 시도
    const restaurants = (
      parsed.restaurants ||
      parsed.items ||
      parsed.results ||
      parsed.data ||
      []
    ).slice(0, 15);

    if (!restaurants.length) throw new Error('맛집을 찾지 못했어요. 지역명을 더 구체적으로 입력해보세요. (예: 강남역, 홍대입구역)');

    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err.message);
    if (err.message === 'RATE_LIMIT') return res.status(429).json({ error: 'AI 서비스 요청 한도 초과. 잠시 후 다시 시도해주세요.' });
    return res.status(500).json({ error: err.message || '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
