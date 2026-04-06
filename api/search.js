// api/search.js - Vercel Serverless Function
// ✅ 네이버 공식 Local Search API
// ✅ 3번 병렬 요청 후 합산, 15개 미달 시 추가 요청으로 보충
// ✅ 무조건 최대 15개 반환
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET

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

function stripTags(str) {
  return (str || '').replace(/<[^>]*>/g, '').trim();
}

function categoryToEmoji(cat) {
  if (!cat) return '🍽️';
  if (cat.includes('한식')) return '🍚';
  if (cat.includes('일식') || cat.includes('스시') || cat.includes('초밥') || cat.includes('라멘')) return '🍣';
  if (cat.includes('중식') || cat.includes('중국')) return '🥟';
  if (cat.includes('양식') || cat.includes('이탈리') || cat.includes('스테이크') || cat.includes('파스타')) return '🍝';
  if (cat.includes('카페') || cat.includes('커피') || cat.includes('디저트') || cat.includes('베이커리')) return '☕';
  if (cat.includes('치킨')) return '🍗';
  if (cat.includes('피자')) return '🍕';
  if (cat.includes('버거') || cat.includes('햄버거')) return '🍔';
  if (cat.includes('분식') || cat.includes('떡볶') || cat.includes('순대')) return '🍢';
  if (cat.includes('해산물') || cat.includes('횟집') || cat.includes('조개') || cat.includes('게')) return '🐟';
  if (cat.includes('고기') || cat.includes('구이') || cat.includes('삼겹') || cat.includes('갈비') || cat.includes('곱창')) return '🥩';
  if (cat.includes('국밥') || cat.includes('설렁탕') || cat.includes('해장')) return '🍲';
  if (cat.includes('베트남') || cat.includes('태국') || cat.includes('인도') || cat.includes('아시아')) return '🌏';
  if (cat.includes('술집') || cat.includes('이자카야') || cat.includes('포차') || cat.includes('호프')) return '🍺';
  if (cat.includes('냉면') || cat.includes('국수') || cat.includes('칼국수')) return '🍜';
  return '🍽️';
}

function cleanCategory(raw) {
  if (!raw) return '음식점';
  const parts = raw.split('>').map(s => s.trim()).filter(Boolean);
  const filtered = parts.filter(p => p !== '음식점' && p !== '카페');
  return filtered.slice(0, 2).join(' · ') || parts[0] || '음식점';
}

// 네이버 Local Search API 호출 (display=5 고정)
async function naverSearch(query, clientId, clientSecret) {
  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=5&start=1&sort=comment`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`네이버 API 오류 (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.items || [];
}

// 중복 제거 (식당명 기준)
function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const name = stripTags(item.title);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// 아이템 → 결과 포맷 변환
function formatItem(item) {
  const rawCat = item.category || '';
  return {
    name: stripTags(item.title),
    category: cleanCategory(rawCat),
    emoji: categoryToEmoji(rawCat),
    address: item.roadAddress || item.address || '',
    naverUrl: item.link || '',
  };
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
  if (!region || typeof region !== 'string' || !region.trim()) {
    return res.status(400).json({ error: '지역명을 입력해주세요.' });
  }
  if (region.length > 50) return res.status(400).json({ error: '지역명이 너무 길어요.' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: '서버 설정 오류입니다. (네이버 API 키 미설정)' });
  }

  const q = region.trim();

  // 키워드 목록 (다양하게 준비 → 중복 최소화)
  const keywords = [
    `${q} 맛집`,
    `${q} 한식 맛집`,
    `${q} 일식 맛집`,
    `${q} 양식 맛집`,
    `${q} 고기 맛집`,
  ];

  try {
    // ── 1단계: 3개 병렬 요청 ─────────────────────────────────────────
    const [r1, r2, r3] = await Promise.all([
      naverSearch(keywords[0], clientId, clientSecret),
      naverSearch(keywords[1], clientId, clientSecret),
      naverSearch(keywords[2], clientId, clientSecret),
    ]);

    let collected = dedupe([...r1, ...r2, ...r3]);

    // ── 2단계: 15개 미달이면 추가 2개 요청으로 보충 ──────────────────
    if (collected.length < 15) {
      const [r4, r5] = await Promise.all([
        naverSearch(keywords[3], clientId, clientSecret),
        naverSearch(keywords[4], clientId, clientSecret),
      ]);
      collected = dedupe([...collected, ...r4, ...r5]);
    }

    if (!collected.length) {
      return res.status(200).json({
        restaurants: [],
        message: '검색 결과가 없어요. 지역명을 더 구체적으로 입력해보세요. (예: 강남역, 홍대입구역)'
      });
    }

    const restaurants = collected.slice(0, 15).map(formatItem);
    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message || '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
