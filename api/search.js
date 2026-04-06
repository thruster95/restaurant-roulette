// api/search.js - Vercel Serverless Function
// ✅ API 키는 여기 서버에만 존재, 클라이언트에 절대 노출되지 않음

// 간단한 IP 기반 Rate Limiting (메모리, 서버 재시작 시 초기화)
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1분
const RATE_LIMIT_MAX = 5;            // 분당 최대 5회

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW;
  }
  record.count++;
  rateLimit.set(ip, record);
  return record.count <= RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });
  }

  // Rate Limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '요청이 너무 많아요. 1분 후에 다시 시도해주세요.' });
  }

  const { region } = req.body || {};
  if (!region || typeof region !== 'string' || region.trim().length === 0) {
    return res.status(400).json({ error: '지역명을 입력해주세요.' });
  }
  if (region.length > 50) {
    return res.status(400).json({ error: '지역명이 너무 길어요.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버 설정 오류입니다. 관리자에게 문의해주세요.' });
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-search-preview',
        web_search_options: {},
        messages: [
          {
            role: 'system',
            content: `당신은 맛집 검색 전문가입니다. 웹 검색으로 사용자가 요청한 지역의 실제 맛집을 찾아주세요.
다양한 음식 종류의 식당 최대 15개를 수집하세요.
반드시 아래 JSON 형식으로만 응답하고, JSON 외 텍스트나 마크다운 코드블록은 절대 포함하지 마세요.
{"restaurants":[{"name":"식당명","category":"음식카테고리(한식/일식/중식/양식 등)","menu":"대표메뉴2-3가지","address":"주소"}]}`
          },
          {
            role: 'user',
            content: `"${region.trim()}" 근처 맛집 15개를 웹 검색으로 찾아서 JSON으로만 알려주세요.`
          }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errData = await openaiRes.json().catch(() => ({}));
      console.error('OpenAI error:', errData);
      if (openaiRes.status === 429) {
        return res.status(429).json({ error: 'AI 서비스가 일시적으로 사용량 한도에 도달했어요. 잠시 후 다시 시도해주세요.' });
      }
      return res.status(502).json({ error: 'AI 서비스 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
    }

    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = text.match(/\{[\s\S]*"restaurants"[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        return res.status(502).json({ error: '검색 결과를 파싱할 수 없어요. 다시 시도해주세요.' });
      }
    }

    const restaurants = (parsed.restaurants || []).slice(0, 15);
    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
