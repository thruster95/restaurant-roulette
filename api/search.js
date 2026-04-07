// api/search.js - Vercel Serverless Function
// ✅ 카테고리 1개만 검색해서 반환 (빠름, 타임아웃 없음)
// ✅ 프론트에서 5번 호출해서 누적
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30; // 5번씩 호출하므로 여유있게

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: '잠시 후 다시 시도해주세요.' });

  const { region, keyword } = req.body || {};
  if (!region || !keyword) return res.status(400).json({ error: '파라미터가 없어요.' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: '서버 설정 오류입니다.' });

  try {
    const query = `${region.trim()} ${keyword.trim()}`;
    const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=5&start=1&sort=comment`;
    const naverRes = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      }
    });

    if (!naverRes.ok) {
      return res.status(200).json({ items: [] }); // 실패해도 빈 배열 반환 (프론트에서 계속 진행)
    }

    const data = await naverRes.json();
    const items = (data.items || []).map(item => {
      const rawCat = item.category || '';
      return {
        name: stripTags(item.title),
        category: cleanCategory(rawCat),
        emoji: categoryToEmoji(rawCat),
        address: item.roadAddress || item.address || '',
        naverUrl: item.link || '',
      };
    });

    return res.status(200).json({ items });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(200).json({ items: [] }); // 실패해도 빈 배열 반환
  }
}
