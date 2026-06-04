import fs from 'fs';
import path from 'path';
import https from 'https';

// ============ Load data ============
let data = null;
try {
  const dataDir = path.join(process.cwd(), 'data');
  data = {
    cards: JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8')),
    spreads: JSON.parse(fs.readFileSync(path.join(dataDir, 'spreads.json'), 'utf-8')),
    faqs: JSON.parse(fs.readFileSync(path.join(dataDir, 'faq.json'), 'utf-8')),
    questions: JSON.parse(fs.readFileSync(path.join(dataDir, 'questions.json'), 'utf-8')),
  };
} catch (e) {
  console.error('Data load failed:', e.message);
}

const readingsStore = [];

// ============ LLM ============
const LLM_KEY = process.env.LLM_API_KEY || 'e5f6ecdf59924cf9a1fab336b3c2802a.lmeBF2S6sNZZK4qm';

async function callLLM(messages, opts = {}) {
  if (!LLM_KEY) return null;
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'glm-4.7', messages, temperature: opts.temp ?? 0.7, max_tokens: opts.max || 2000 });
    const req = https.request({
      hostname: 'open.bigmodel.cn', port: 443, path: '/api/paas/v4/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_KEY}` }, timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).choices?.[0]?.message?.content || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function aiInterpret(drawnCards, question, lang) {
  const info = drawnCards.map((c, i) => {
    const pos = c.position?.nameZh || c.position?.nameEn || `Pos${i + 1}`;
    const dir = c.card.reversed ? (lang === 'zh' ? '逆位' : 'Reversed') : (lang === 'zh' ? '正位' : 'Upright');
    return `【${pos}】${c.card.nameZh}(${c.card.nameEn}) ${dir}\nKeywords: ${(c.card.keywords || []).join(',')}\nMeaning: ${c.card.meaning}`;
  }).join('\n\n');
  const sp = lang === 'zh' ? '资深塔罗师，温柔诗意。500字内。' : 'Senior tarot reader, warm, under 500 words.';
  const up = lang === 'zh' ? `问题: ${question || '未指定'}\n\n牌:\n${info}\n\n请解读。` : `Q: ${question || 'None'}\n\nCards:\n${info}\n\nInterpret.`;
  return callLLM([{ role: 'system', content: sp }, { role: 'user', content: up }], { temp: 0.8, max: 1500 });
}

async function aiOracle(msg, history, lang) {
  const sp = lang === 'zh' ? '博学的塔罗向导，智慧温柔。300字内。' : 'Knowledgeable tarot oracle, warm, under 300 words.';
  return callLLM([{ role: 'system', content: sp }, ...(Array.isArray(history) ? history.slice(-10) : []), { role: 'user', content: msg }], { temp: 0.85, max: 800 });
}

async function aiRewriteQ(q, lang) {
  const sp = lang === 'zh' ? '将问题改写为塔罗解读的开放式问题。只返回改写后的问题。' : 'Rewrite into open-ended tarot question. Return only.';
  const r = await callLLM([{ role: 'system', content: sp }, { role: 'user', content: `改写: "${q}"` }], { temp: 0.5, max: 200 });
  return r?.trim() || null;
}

function ruleInterpret(drawnCards) {
  const descs = drawnCards.map(c => {
    const pos = c.position?.nameZh || c.position?.nameEn || `Pos${c.position?.index || '?'}`;
    return `【${pos}】${c.card.nameZh}(${c.card.reversed ? '逆位' : '正位'}): ${c.card.meaning}`;
  });
  const major = drawnCards.filter(c => { const id = c.card.id; return id.length <= 5 || id.startsWith('0') || id.startsWith('1'); }).length;
  const rev = drawnCards.filter(c => c.card.reversed).length;
  let theme = major >= 2 ? '多张大阿卡纳出现，触及人生核心课题。' : major === 1 ? '大阿卡纳能量主导，关注重要转折。' : '小阿卡纳聚焦日常事务与情感体验。';
  return { interpretation: `${theme}\n\n${descs.join('\n\n')}\n\n【综合解读】保持开放心态，相信直觉。${rev > 0 ? '\n\n有逆位牌出现，提醒放慢脚步重新审视。' : ''}`, theme, summary: drawnCards.flatMap(c => c.card.keywords || []).slice(0, 8).join('、'), generatedBy: 'rule-engine' };
}

function ruleOracle(msg, lang) {
  const m = msg.toLowerCase();
  const resp = {
    love: lang === 'zh' ? '感情是内在状态的镜子。学会爱自己，健康的爱情自然会流向你。' : 'Love mirrors your inner state.',
    career: lang === 'zh' ? '事业困惑源于与使命感的连接。塔罗帮你看清职业能量和潜在机会。' : 'Career challenges connect to your sense of purpose.',
    growth: lang === 'zh' ? '自我成长是灵魂最深的渴望。迷茫是一个邀请——停下来倾听内心。' : 'Self-growth is the soul\'s deepest desire.',
    card: lang === 'zh' ? '塔罗是78张牌的智慧系统，22张大阿卡纳和56张小阿卡纳。' : 'Tarot has 78 cards, 22 Major and 56 Minor Arcana.',
    general: lang === 'zh' ? '塔罗是一面镜子，反射你内心的智慧。答案早已在你心中。' : 'The tarot mirrors your inner wisdom.'
  };
  const kws = { love: ['爱', '感情', '关系', '恋情', '分手'], career: ['工作', '事业', '职业', '升职', '创业'], growth: ['成长', '迷茫', '人生', '方向'], card: ['牌', '塔罗', '牌阵'] };
  for (const [k, arr] of Object.entries(kws)) { if (arr.some(w => m.includes(w))) return { reply: resp[k], topic: k, generatedBy: 'rule-engine' }; }
  return { reply: resp.general, topic: 'general', generatedBy: 'rule-engine' };
}

function ruleRewrite(original) {
  if (!original?.trim()) return { rewritten: original || '', generatedBy: 'rule-engine', changed: false };
  let q = original.trim();
  if (!/[?？]$/.test(q)) q += '？';
  const reps = [[/他会不会/gi, '我是否有可能'], [/她会不会/gi, '我是否有可能'], [/能不能/gi, '如何能够'], [/怎么办/gi, '应该如何应对'], [/行不行/gi, '是否可行'], [/该不该/gi, '是否应该'], [/好不好/gi, '是否适宜']];
  let changed = false;
  for (const [p, r] of reps) { if (p.test(q)) { q = q.replace(p, r); changed = true; } }
  return { rewritten: q, generatedBy: 'rule-engine', changed };
}

// ============ Helpers ============
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function getBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return resolve({});
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function getLang(req) {
  const url = new URL(req.url, 'http://localhost');
  const lang = url.searchParams.get('lang') || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'zh';
  return ['zh', 'en'].includes(lang) ? lang : 'zh';
}

function matchRoute(pattern, url) {
  const re = new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$');
  const m = url.match(re);
  return m ? m.slice(1) : null;
}

// ============ Router ============
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept-Language');
  if (req.method === 'OPTIONS') return res.statusCode = 204, res.end();

  // Parse URL path
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/$/, '') || '/';

  try {
    // Health
    if (p === '/api/health' || p === '/') {
      return json(res, 200, { success: true, message: 'Tarot API running', dataLoaded: !!data, timestamp: new Date().toISOString() });
    }

    if (!data) return json(res, 503, { success: false, error: 'Data not loaded. Check deployment.' });
    const { cards, spreads, faqs, questions } = data;

    // ----- Cards -----
    if (p === '/api/cards' && req.method === 'GET') {
      let result = [...cards];
      const { arcana, suit, element, court, keyword, page = 1, limit = 78 } = Object.fromEntries(url.searchParams);
      if (arcana) result = result.filter(c => c.arcana === arcana);
      if (suit) result = result.filter(c => c.suit === suit);
      if (element) result = result.filter(c => c.element === element);
      if (court) result = result.filter(c => c.court === court);
      if (keyword) {
        const kw = keyword.toLowerCase();
        result = result.filter(c => c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) || c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw)));
      }
      const pg = parseInt(page), lm = parseInt(limit), total = result.length;
      return json(res, 200, { success: true, data: result.slice((pg - 1) * lm, pg * lm), pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
    }
    if (p === '/api/cards/major-arcana') {
      const r = cards.filter(c => c.arcana === 'major');
      return json(res, 200, { success: true, data: r, total: r.length });
    }
    {
      const m = matchRoute('/api/cards/suit/:suit', p);
      if (m) {
        const suit = m[0]; if (!['wands', 'cups', 'swords', 'pentacles'].includes(suit)) return json(res, 400, { success: false, error: 'Invalid suit' });
        const r = cards.filter(c => c.suit === suit);
        return json(res, 200, { success: true, data: r, total: r.length });
      }
    }
    if (p === '/api/cards/random') {
      let pool = [...cards];
      const { count = 1, arcana, suit } = Object.fromEntries(url.searchParams);
      if (arcana) pool = pool.filter(c => c.arcana === arcana);
      if (suit) pool = pool.filter(c => c.suit === suit);
      return json(res, 200, { success: true, data: pool.sort(() => Math.random() - 0.5).slice(0, Math.min(parseInt(count), pool.length)) });
    }
    {
      const m = matchRoute('/api/cards/:id', p);
      if (m) {
        const card = cards.find(c => c.id === m[0]);
        return card ? json(res, 200, { success: true, data: card }) : json(res, 404, { success: false, error: 'Card not found' });
      }
    }

    // ----- Spreads -----
    if (p === '/api/spreads' && req.method === 'GET') {
      let result = [...spreads];
      const { category } = Object.fromEntries(url.searchParams);
      if (category) result = result.filter(s => s.category === category);
      return json(res, 200, { success: true, data: result, total: result.length });
    }
    {
      const m = matchRoute('/api/spreads/:id', p);
      if (m) {
        if (req.method === 'GET') {
          const spread = spreads.find(s => s.id === m[0]);
          return spread ? json(res, 200, { success: true, data: spread }) : json(res, 404, { success: false, error: 'Spread not found' });
        }
        if (req.method === 'POST' && p.endsWith('/draw')) {
          const spread = spreads.find(s => s.id === m[0]);
          if (!spread) return json(res, 404, { success: false, error: 'Spread not found' });
          const body = await getBody(req);
          const shuffled = [...cards].sort(() => Math.random() - 0.5);
          const drawn = shuffled.slice(0, spread.cardCount);
          const isReversed = () => Math.random() > 0.5;
          const reading = {
            id: `reading_${Date.now()}`, spread: spread.id, spreadName: spread.nameZh,
            question: body.question || null, timestamp: new Date().toISOString(),
            cards: spread.positions.map((pos, i) => {
              const card = drawn[i]; const rev = isReversed();
              return { position: pos, card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed: rev, keywords: rev ? card.keywordsReversed : card.keywordsUpright, meaning: rev ? card.meaningReversed : card.meaningUpright } };
            })
          };
          readingsStore.unshift(reading); if (readingsStore.length > 100) readingsStore.pop();
          if (body.question) {
            const lang = getLang(req);
            try {
              const aiR = await aiInterpret(reading.cards, body.question, lang);
              reading.interpretation = aiR || ruleInterpret(reading.cards).interpretation;
              reading.interpretationMeta = { theme: '', summary: '', generatedBy: aiR ? 'ai-zhipu' : 'rule-engine' };
            } catch { const ri = ruleInterpret(reading.cards); reading.interpretation = ri.interpretation; reading.interpretationMeta = { theme: ri.theme, summary: ri.summary, generatedBy: ri.generatedBy }; }
          }
          return json(res, 200, { success: true, data: reading });
        }
      }
    }

    // ----- Reading -----
    if (p === '/api/reading' && req.method === 'POST') {
      const body = await getBody(req);
      const { question, spread: spreadId, cardCount } = body;
      let spread = null; let count = cardCount || 1;
      if (spreadId) { spread = spreads.find(s => s.id === spreadId); if (!spread) return json(res, 400, { success: false, error: 'Invalid spread id' }); count = spread.cardCount; }
      const shuffled = [...cards].sort(() => Math.random() - 0.5);
      const drawn = shuffled.slice(0, count);
      const isReversed = () => Math.random() > 0.5;
      const result = {
        id: `reading_${Date.now()}`, question: question || null,
        spread: spread ? { id: spread.id, nameZh: spread.nameZh } : null, timestamp: new Date().toISOString(),
        cards: drawn.map((card, i) => { const rev = isReversed(); return { position: spread ? spread.positions[i] : { index: i + 1, nameZh: `第${i + 1}张` }, card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed: rev, keywords: rev ? card.keywordsReversed : card.keywordsUpright, meaning: rev ? card.meaningReversed : card.meaningUpright } }; })
      };
      readingsStore.unshift(result); if (readingsStore.length > 100) readingsStore.pop();
      return json(res, 200, { success: true, data: result });
    }
    if (p === '/api/reading/interpret' && req.method === 'POST') {
      const body = await getBody(req);
      const { cards: inputCards, readingId, question, lang: paramLang } = body;
      const lang = paramLang || getLang(req);
      let targetCards;
      if (readingId) { const stored = readingsStore.find(r => r.id === readingId); if (!stored) return json(res, 404, { success: false, error: 'Reading not found' }); targetCards = stored.cards; }
      else if (inputCards && Array.isArray(inputCards)) targetCards = inputCards;
      else return json(res, 400, { success: false, error: 'Provide "cards" or "readingId"' });
      const aiR = await aiInterpret(targetCards, question || '', lang);
      const result = aiR ? { interpretation: aiR, theme: '', summary: '', generatedBy: 'ai-zhipu' } : { ...ruleInterpret(targetCards) };
      return json(res, 200, { success: true, data: { ...result, lang } });
    }

    // ----- History -----
    if (p === '/api/readings' && req.method === 'GET') {
      const { page = 1, limit = 20 } = Object.fromEntries(url.searchParams);
      const pg = parseInt(page), lm = parseInt(limit), total = readingsStore.length;
      return json(res, 200, { success: true, data: readingsStore.slice((pg - 1) * lm, pg * lm), pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
    }
    {
      const m = matchRoute('/api/readings/:id', p);
      if (m) {
        if (req.method === 'GET') {
          const r = readingsStore.find(r => r.id === m[0]);
          return r ? json(res, 200, { success: true, data: r }) : json(res, 404, { success: false, error: 'Reading not found' });
        }
        if (req.method === 'DELETE') {
          const idx = readingsStore.findIndex(r => r.id === m[0]);
          if (idx === -1) return json(res, 404, { success: false, error: 'Reading not found' });
          readingsStore.splice(idx, 1);
          return json(res, 200, { success: true, message: 'Reading deleted' });
        }
      }
    }

    // ----- Daily -----
    if (p === '/api/daily-card') {
      const card = cards[Math.floor(Math.random() * cards.length)];
      const reversed = Math.random() > 0.5;
      return json(res, 200, { success: true, data: { date: new Date().toISOString().split('T')[0], card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright, description: card.description } } });
    }

    // ----- Search -----
    if (p === '/api/search') {
      const { q, type = 'all' } = Object.fromEntries(url.searchParams);
      if (!q) return json(res, 400, { success: false, error: 'Query "q" required' });
      const result = {}, kw = q.toLowerCase();
      if (type === 'all' || type === 'cards') result.cards = cards.filter(c => c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) || c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw))).map(c => ({ id: c.id, nameZh: c.nameZh, nameEn: c.nameEn, image: c.image }));
      if (type === 'all' || type === 'spreads') result.spreads = spreads.filter(s => s.nameEn.toLowerCase().includes(kw) || s.nameZh.includes(kw) || s.description.includes(kw));
      return json(res, 200, { success: true, data: result });
    }

    // ----- Questions -----
    if (p === '/api/questions' && req.method === 'GET') {
      let result = [...questions];
      const { category } = Object.fromEntries(url.searchParams);
      if (category) result = result.filter(q => q.category === category);
      return json(res, 200, { success: true, data: result });
    }
    if (p === '/api/questions/rewrite' && req.method === 'POST') {
      const body = await getBody(req);
      if (!body.question) return json(res, 400, { success: false, error: 'Field "question" required' });
      const lang = body.lang || getLang(req);
      const aiR = await aiRewriteQ(body.question, lang);
      if (aiR) return json(res, 200, { success: true, data: { original: body.question.trim(), rewritten: aiR, changed: aiR !== body.question.trim(), generatedBy: 'ai-zhipu' } });
      const fr = ruleRewrite(body.question);
      return json(res, 200, { success: true, data: { original: body.question.trim(), rewritten: fr.rewritten, changed: fr.changed, generatedBy: fr.generatedBy } });
    }

    // ----- FAQ -----
    if (p === '/api/faq') return json(res, 200, { success: true, data: faqs });

    // ----- Oracle -----
    if (p === '/api/oracle/chat' && req.method === 'POST') {
      const body = await getBody(req);
      if (!body.message) return json(res, 400, { success: false, error: 'Field "message" required' });
      const lang = body.lang || getLang(req);
      const aiReply = await aiOracle(body.message, body.history, lang);
      const reply = aiReply || ruleOracle(body.message, lang).reply;
      return json(res, 200, { success: true, data: { message: reply, lang, generatedBy: aiReply ? 'ai-zhipu' : 'rule-engine', timestamp: new Date().toISOString() } });
    }

    // ----- Stats -----
    if (p === '/api/stats') {
      const suits = {}; ['wands', 'cups', 'swords', 'pentacles'].forEach(s => suits[s] = cards.filter(c => c.suit === s).length);
      return json(res, 200, { success: true, data: { totalCards: cards.length, majorArcana: cards.filter(c => c.arcana === 'major').length, minorArcana: cards.filter(c => c.arcana === 'minor').length, suits, totalSpreads: spreads.length, totalFAQs: faqs.length, totalReadings: readingsStore.length, llmProvider: 'zhipu' } });
    }

    // 404
    return json(res, 404, { success: false, error: 'Route not found' });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}