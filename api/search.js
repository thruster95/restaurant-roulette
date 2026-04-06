// api/search.js - Vercel Serverless Function
// ✅ API 키는 서버에만 존재, 클라이언트에 절대 노출되지 않음
// ✅ 네이버 플레이스 기준 별점 높은 순 15개 반환

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 5;

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });

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
  if (!apiKey) return res.status(500).json({ error: '서버 설정 오류입니다.' });

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
            content: `당신은 네이버 플레이스 맛집 검색 전문가입니다.

반드시 다음 순서로 실행하세요:
1. 웹 검색으로 네이버 플레이스(place.naver.com)에서 "{지역} 맛집"을 검색하세요.
2. 네이버 플레이스의 별점(★)이 높은 순으로 식당을 정렬하세요.
3. 별점이 같으면 리뷰 수가 많은 순으로 정렬하세요.
4. 상위 15개 식당을 선별하세요.

반드시 네이버 플레이스(place.naver.com 또는 map.naver.com)에서 실제로 검색된 결과만 사용하세요.
네이버 플레이스 URL 형식 예시: https://place.naver.com/restaurant/12345678

응답은 반드시 아래 JSON 형식으로만 하고, JSON 외 텍스트나 마크다운 코드블록은 절대 포함하지 마세요:
{"restaurants":[{"name":"식당명","category":"음식카테고리","menu":"대표메뉴2-3가지","address":"도로명주소","rating":"4.7","reviews":"리뷰수(예:1,203)","naverUrl":"네이버플레이스URL"}]}`
          },
          {
            role: 'user',
            content: `네이버 플레이스에서 "${region.trim()}" 맛집을 검색해서 별점 높은 순으로 15개를 JSON으로만 알려주세요.`
          }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errData = await openaiRes.json().catch(() => ({}));
      console.error('OpenAI error:', errData);
      if (openaiRes.status === 429) return res.status(429).json({ error: 'AI 서비스 요청 한도 초과. 잠시 후 다시 시도해주세요.' });
      return res.status(502).json({ error: 'AI 서비스 오류가 발생했어요.' });
    }

    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = text.match(/\{[\s\S]*"restaurants"[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return res.status(502).json({ error: '결과를 파싱할 수 없어요. 다시 시도해주세요.' });
    }

    const restaurants = (parsed.restaurants || []).slice(0, 15);
    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
