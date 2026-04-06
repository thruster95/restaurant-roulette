// api/search.js - Vercel Serverless Function
// ✅ AI(GPT-4o) 자체 지식으로 별점/리뷰 기반 맛집 추천
// ✅ 웹 검색 없음 → 빠르고 안정적 (1~3초)
// ✅ response_format: json_object 로 JSON 100% 보장
// 필요 환경변수: OPENAI_API_KEY

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW; }
  record.count++;
  rateLimit.set(ip, record);
  return record.count <= RATE_LIMIT_MAX;
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
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `당신은 한국 맛집 전문가입니다. 
사용자가 지역명을 주면, 그 지역에서 실제로 유명하고 평판이 좋은 맛집을 추천해주세요.
네이버 플레이스, 카카오맵, 망고플레이트 등에서 별점이 높고 리뷰가 많은 식당을 기준으로 선정하세요.
다양한 음식 종류(한식, 일식, 중식, 양식, 카페 등)를 골고루 포함하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "restaurants": [
    {
      "name": "식당명",
      "category": "음식 카테고리 (예: 한식, 일식, 중식, 양식, 카페 등)",
      "menu": "대표 메뉴 2~3가지",
      "address": "도로명 주소 또는 동 주소",
      "rating": "네이버/카카오 기준 예상 별점 (예: 4.5)",
      "reviews": "리뷰 수 또는 평판 (예: 리뷰 2,300개 이상 / 줄서는 맛집 등)",
      "description": "한 줄 특징 (예: 20년 전통의 손칼국수, 웨이팅 필수)"
    }
  ]
}`
          },
          {
            role: 'user',
            content: `"${q}" 주변에서 별점 높고 유명한 맛집 15개를 추천해주세요. 실제로 존재하는 식당만 알려주세요.`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error('AI 요청 한도 초과. 잠시 후 다시 시도해주세요.');
      throw new Error(err?.error?.message || `API 오류 (${response.status})`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('결과 변환에 실패했어요. 다시 시도해주세요.');
    }

    const restaurants = (parsed.restaurants || []).slice(0, 15);
    if (!restaurants.length) throw new Error('맛집을 찾지 못했어요. 다른 지역명을 입력해보세요.');

    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err.message);
    if (err.message === 'RATE_LIMIT') return res.status(429).json({ error: 'AI 서비스 요청 한도 초과. 잠시 후 다시 시도해주세요.' });
    return res.status(500).json({ error: err.message || '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
