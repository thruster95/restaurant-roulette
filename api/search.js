// api/search.js - Vercel Serverless Function
// ✅ 네이버 공식 Local Search API 사용
// ✅ 빠름 (300~500ms), 안정적, 완전 무료
// ✅ 3번 병렬 호출로 최대 15개 수집
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1분
const RATE_LIMIT_MAX = 10;           // 분당 최대 10회

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW; }
  record.count++;
  rateLimit.set(ip, record);
  return record.count <= RATE_LIMIT_MAX;
}

// 네이버 HTML 태그 제거 (<b>, </b> 등)
function stripTags(str) {
  return (str || '').replace(/<[^>]*>/g, '').trim();
}

// 카테고리 → 이모지
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

// 카테고리 정리: "음식점 > 한식 > 삼겹살" → "한식 · 삼겹살"
function cleanCategory(raw) {
  if (!raw) return '음식점';
  const parts = raw.split('>').map(s => s.trim()).filter(Boolean);
  const filtered = parts.filter(p => p !== '음식점' && p !== '카페');
  return filtered.slice(0, 2).join(' · ') || parts[0] || '음식점';
}

// 네이버 Local Search API 단일 호출
async function naverSearch(query, clientId, clientSecret, start) {
  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=5&start=${start}&sort=comment`;
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
  if (!region || typeof region !== 'string' || !region.trim()) {
    return res.status(400).json({ error: '지역명을 입력해주세요.' });
  }
  if (region.length > 50) return res.status(400).json({ error: '지역명이 너무 길어요.' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: '서버 설정 오류입니다. (네이버 API 키 미설정)' });
  }

  const query = `${region.trim()} 맛집`;

  try {
    // 3번 병렬 호출 → 최대 15개 수집 (start: 1, 6, 11)
    const [r1, r2, r3] = await Promise.all([
      naverSearch(query, clientId, clientSecret, 1),
      naverSearch(query, clientId, clientSecret, 6),
      naverSearch(query, clientId, clientSecret, 11),
    ]);

    const allItems = [
      ...(r1.items || []),
      ...(r2.items || []),
      ...(r3.items || []),
    ];

    if (!allItems.length) {
      return res.status(200).json({
        restaurants: [],
        message: '검색 결과가 없어요. 지역명을 더 구체적으로 입력해보세요. (예: 강남역, 홍대입구역)'
      });
    }

    // 중복 제거 (같은 식당명)
    const seen = new Set();
    const unique = allItems.filter(item => {
      const name = stripTags(item.title);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });

    const restaurants = unique.slice(0, 15).map(item => {
      const rawCat = item.category || '';
      return {
        name: stripTags(item.title),
        category: cleanCategory(rawCat),
        emoji: categoryToEmoji(rawCat),
        address: item.roadAddress || item.address || '',
        naverUrl: item.link || '',   // 네이버 플레이스 직접 링크
        mapx: item.mapx || '',       // 좌표 (카카오/구글 지도 검색용)
        mapy: item.mapy || '',
      };
    });

    return res.status(200).json({ restaurants });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message || '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}
