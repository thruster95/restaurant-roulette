// api/search.js - Vercel Serverless Function
// ✅ mode=location: 카카오 로컬 API
//    - "맛집" 키워드 + 위도/경도 + radius=1000
//    - sort=accuracy (정확도순 = 인기/관련도 높은 순)
//    - size=30, page 1~3 병렬 호출 → 최대 90개
//    - meta.is_end 로 결과 없으면 조기 종료
// ✅ mode=region: 네이버 Local Search API (지역명 검색)
// 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, KAKAO_REST_API_KEY

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 20;

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

function formatKakaoDoc(doc) {
  const distNum = parseInt(doc.distance || '0');
  const distLabel = distNum >= 1000
    ? `${(distNum / 1000).toFixed(1)}km`
    : `${distNum}m`;
  return {
    name: doc.place_name || '',
    category: cleanCategory(doc.category_name || ''),
    emoji: categoryToEmoji(doc.category_name || ''),
    address: doc.road_address_name || doc.address_name || '',
    naverUrl: `https://map.naver.com/p/search/${encodeURIComponent(doc.place_name || '')}`,
    kakaoUrl: doc.place_url || '',
    distance: distLabel,
  };
}

// 카카오 단일 페이지 호출
async function kakaoSearchPage(lat, lng, page, kakaoKey) {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json` +
    `?query=${encodeURIComponent('맛집')}` +
    `&x=${lng}&y=${lat}` +
    `&radius=1000` +
    `&sort=accuracy` +
    `&size=30` +
    `&page=${page}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `KakaoAK ${kakaoKey}` }
  });

  if (!res.ok) {
    console.error(`카카오 API 오류 page${page}:`, res.status, await res.text());
    return { documents: [], isEnd: true };
  }

  const data = await res.json();
  return {
    documents: data.documents || [],
    isEnd: data.meta?.is_end ?? true,
  };
}

// ── 카카오 로컬 API (위치 기반 반경 1km, 정확도순) ───────────────────
async function searchByLocation(lat, lng, kakaoKey) {
  // page 1~3 병렬 호출 (최대 90개)
  const [p1, p2, p3] = await Promise.all([
    kakaoSearchPage(lat, lng, 1, kakaoKey),
    kakaoSearchPage(lat, lng, 2, kakaoKey),
    kakaoSearchPage(lat, lng, 3, kakaoKey),
  ]);

  // p1이 끝이면 p2, p3는 빈 배열이므로 자동으로 처리됨
  const allDocs = [
    ...p1.documents,
    ...(p1.isEnd ? [] : p2.documents),
    ...(p1.isEnd || p2.isEnd ? [] : p3.documents),
  ];

  // 중복 제거
  const seen = new Set();
  const unique = allDocs.filter(doc => {
    if (seen.has(doc.id)) return false;
    seen.add(doc.id);
    return true;
  });

  return unique.map(formatKakaoDoc);
}

// ── 네이버 Local Search API (지역명 검색) ────────────────────────────
async function searchByRegion(region, keyword, clientId, clientSecret) {
  const query = `${region} ${keyword}`;
  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=5&start=1&sort=comment`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map(item => ({
    name: stripTags(item.title),
    category: cleanCategory(item.category || ''),
    emoji: categoryToEmoji(item.category || ''),
    address: item.roadAddress || item.address || '',
    naverUrl: item.link || '',
    kakaoUrl: '',
    distance: '',
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: '잠시 후 다시 시도해주세요.' });

  const { mode, region, keyword, lat, lng } = req.body || {};

  try {
    let items = [];

    if (mode === 'location') {
      const kakaoKey = process.env.KAKAO_REST_API_KEY;
      if (!kakaoKey) return res.status(500).json({ error: '카카오 API 키가 설정되지 않았어요. Vercel 환경변수에 KAKAO_REST_API_KEY를 추가해주세요.' });
      if (!lat || !lng) return res.status(400).json({ error: `위치 정보가 없어요. lat=${lat}, lng=${lng}` });

      items = await searchByLocation(parseFloat(lat), parseFloat(lng), kakaoKey);

    } else {
      const clientId = process.env.NAVER_CLIENT_ID;
      const clientSecret = process.env.NAVER_CLIENT_SECRET;
      if (!clientId || !clientSecret) return res.status(500).json({ error: '네이버 API 키가 설정되지 않았어요.' });
      if (!region || !keyword) return res.status(400).json({ error: '파라미터가 없어요.' });

      items = await searchByRegion(region, keyword, clientId, clientSecret);
    }

    return res.status(200).json({ items });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message, items: [] });
  }
}
