import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Load data — try multiple paths for Vercel compatibility
function loadData() {
  const paths = [
    path.join(__dirname, '..', 'data'),
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), 'api', '..', 'data'),
  ];
  for (const dataDir of paths) {
    try {
      return {
        cards: JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8')),
        spreads: JSON.parse(fs.readFileSync(path.join(dataDir, 'spreads.json'), 'utf-8')),
        faqs: JSON.parse(fs.readFileSync(path.join(dataDir, 'faq.json'), 'utf-8')),
        questions: JSON.parse(fs.readFileSync(path.join(dataDir, 'questions.json'), 'utf-8')),
      };
    } catch { /* try next */ }
  }
  return null;
}

const data = loadData();

// ============ LLM helpers (inline, no external deps) ============
import https from 'https';
import http from 'http';

const LLM_API_KEY = process.env.LLM_API_KEY || 'e5f6ecdf59924cf9a1fab336b3c2802a.lmeBF2S6sNZZK4qm';
const LLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const LLM_MODEL = 'glm-4.7';

async function callLLM(messages, options = {}) {
  if (!LLM_API_KEY) return null;
  const url = new URL(`${LLM_BASE_URL}/chat/completions`);
  const body = JSON.stringify({ model: LLM_MODEL, messages, temperature: options.temperature ?? 0.7, max_tokens: options.maxTokens || 2000 });
  return new Promise((resolve) => {
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` }, timeout: 25000 }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d).choices?.[0]?.message?.content || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function aiInterpret(drawnCards, question, lang) {
  const cardsInfo = drawnCards.map((c, i) => {
    const pos = c.position?.nameZh || c.position?.nameEn || `Pos${i + 1}`;
    const dir = c.card.reversed ? (lang === 'zh' ? '逆位' : 'Reversed') : (lang === 'zh' ? '正位' : 'Upright');
    return `【${pos}】${c.card.nameZh}(${c.card.nameEn}) ${dir}\nKeywords: ${(c.card.keywords || []).join(',')}\nMeaning: ${c.card.meaning}`;
  }).join('\n\n');
  const sp = lang === 'zh' ? '资深塔罗师，温柔诗意。500字内。' : 'Senior tarot reader, warm, poetic, under 500 words.';
  const up = lang === 'zh' ? `问题: ${question || '未指定'}\n\n牌:\n${cardsInfo}\n\n请解读。` : `Q: ${question || 'None'}\n\nCards:\n${cardsInfo}\n\nInterpret.`;
  return callLLM([{ role: 'system', content: sp }, { role: 'user', content: up }], { temperature: 0.8, maxTokens: 1500 });
}

async function aiOracle(message, history, lang) {
  if (!LLM_API_KEY) return null;
  const sp = lang === 'zh' ? '博学的塔罗向导，智慧温柔。300字内。' : 'Knowledgeable tarot oracle, warm, wise. Under 300 words.';
  return callLLM([{ role: 'system', content: sp }, ...(Array.isArray(history) ? history.slice(-10) : []), { role: 'user', content: message }], { temperature: 0.85, maxTokens: 800 });
}

async function aiRewriteQ(question, lang) {
  if (!LLM_API_KEY) return null;
  const sp = lang === 'zh' ? '将问题改写为塔罗解读的开放式问题。只返回改写后的问题。' : 'Rewrite into open-ended tarot question. Return only the question.';
  const r = await callLLM([{ role: 'system', content: sp }, { role: 'user', content: `改写: "${question}"` }], { temperature: 0.5, maxTokens: 200 });
  return r?.trim() || null;
}

function ruleInterpret(drawnCards, question, lang) {
  const descs = drawnCards.map(c => {
    const pos = c.position?.nameZh || c.position?.nameEn || `Pos${c.position?.index || '?'}`;
    return `【${pos}】${c.card.nameZh}(${c.card.reversed ? '逆位' : '正位'}): ${c.card.meaning}`;
  });
  const major = drawnCards.filter(c => { const id = c.card.id; return id.length <= 5 || id.startsWith('0') || id.startsWith('1'); }).length;
  const rev = drawnCards.filter(c => c.card.reversed).length;
  let theme = major >= 2 ? '多张大阿卡纳出现，触及人生核心课题。' : major === 1 ? '大阿卡纳能量主导，关注重要转折。' : '小阿卡纳聚焦日常事务与情感体验。';
  let revNote = rev > 0 ? '\n\n有逆位牌出现，提醒放慢脚步重新审视。' : '';
  return { interpretation: `${theme}\n\n${descs.join('\n\n')}\n\n【综合解读】保持开放心态，相信直觉。${revNote}`, theme, summary: drawnCards.flatMap(c => c.card.keywords || []).slice(0, 8).join('、'), generatedBy: 'rule-engine' };
}

function ruleOracle(msg, lang) {
  const m = msg.toLowerCase();
  const resp = {
    love: lang === 'zh' ? '感情是内在状态的镜子。学会爱自己，健康的爱情自然会流向你。' : 'Love mirrors your inner state. Love yourself first.',
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
  const reps = [[/他会不会/gi, '我是否有可能'], [/她会不会/gi, '我是否有可能'], [/我会不会/gi, '我是否能够'], [/能不能/gi, '如何能够'], [/怎么办/gi, '应该如何应对'], [/行不行/gi, '是否可行'], [/该不该/gi, '是否应该'], [/好不好/gi, '是否适宜'], [/帮我/gi, '请指引我'], [/告诉我/gi, '请指引我了解'], [/我应该/gi, '在当前情况下，我是否可以']];
  let changed = false;
  for (const [p, r] of reps) { if (p.test(q)) { q = q.replace(p, r); changed = true; } }
  return { rewritten: q, generatedBy: 'rule-engine', changed };
}

// ============ API Routes ============
const readingsStore = [];

function getLang(req) {
  const lang = req.query.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'zh';
  return ['zh', 'en'].includes(lang) ? lang : 'zh';
}

// Health — always available
app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'Tarot API running', dataLoaded: !!data, timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({ name: 'Tarot API', version: '3.0.0', dataLoaded: !!data });
});

// Data-dependent routes
function requireData(req, res, next) {
  if (!data) return res.status(503).json({ success: false, error: 'Data not loaded. Check deployment.' });
  next();
}
app.use('/api/cards', requireData);
app.use('/api/spreads', requireData);
app.use('/api/reading', requireData);
app.use('/api/readings', requireData);
app.use('/api/daily-card', requireData);
app.use('/api/search', requireData);
app.use('/api/questions', requireData);
app.use('/api/faq', requireData);
app.use('/api/oracle', requireData);
app.use('/api/stats', requireData);

// Cards
app.get('/api/cards', (req, res) => {
  let result = [...data.cards];
  const { arcana, suit, element, court, keyword, page = 1, limit = 78 } = req.query;
  if (arcana) result = result.filter(c => c.arcana === arcana);
  if (suit) result = result.filter(c => c.suit === suit);
  if (element) result = result.filter(c => c.element === element);
  if (court) result = result.filter(c => c.court === court);
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(c => c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) || c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw)) || c.meaningUpright.includes(kw) || c.meaningReversed.includes(kw));
  }
  const p = parseInt(page), l = parseInt(limit), total = result.length;
  res.json({ success: true, data: result.slice((p - 1) * l, p * l), pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } });
});

app.get('/api/cards/major-arcana', (_req, res) => {
  const result = data.cards.filter(c => c.arcana === 'major');
  res.json({ success: true, data: result, total: result.length });
});

app.get('/api/cards/suit/:suit', (req, res) => {
  const valid = ['wands', 'cups', 'swords', 'pentacles'];
  const suit = req.params.suit.toLowerCase();
  if (!valid.includes(suit)) return res.status(400).json({ success: false, error: 'Invalid suit' });
  const result = data.cards.filter(c => c.suit === suit);
  res.json({ success: true, data: result, total: result.length });
});

app.get('/api/cards/random', (req, res) => {
  let pool = [...data.cards];
  const { count = 1, arcana, suit } = req.query;
  if (arcana) pool = pool.filter(c => c.arcana === arcana);
  if (suit) pool = pool.filter(c => c.suit === suit);
  const c = Math.min(parseInt(count), pool.length);
  res.json({ success: true, data: pool.sort(() => Math.random() - 0.5).slice(0, c) });
});

app.get('/api/cards/:id', (req, res) => {
  const card = data.cards.find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ success: false, error: 'Card not found' });
  res.json({ success: true, data: card });
});

// Spreads
app.get('/api/spreads', (req, res) => {
  let result = [...data.spreads];
  if (req.query.category) result = result.filter(s => s.category === req.query.category);
  res.json({ success: true, data: result, total: result.length });
});

app.get('/api/spreads/:id', (req, res) => {
  const spread = data.spreads.find(s => s.id === req.params.id);
  if (!spread) return res.status(404).json({ success: false, error: 'Spread not found' });
  res.json({ success: true, data: spread });
});

app.post('/api/spreads/:id/draw', async (req, res) => {
  const spread = data.spreads.find(s => s.id === req.params.id);
  if (!spread) return res.status(404).json({ success: false, error: 'Spread not found' });
  const shuffled = [...data.cards].sort(() => Math.random() - 0.5);
  const drawn = shuffled.slice(0, spread.cardCount);
  const isReversed = () => Math.random() > 0.5;
  const reading = {
    id: `reading_${Date.now()}`, spread: spread.id, spreadName: spread.nameZh,
    question: req.body.question || null, timestamp: new Date().toISOString(),
    cards: spread.positions.map((pos, i) => {
      const card = drawn[i]; const reversed = isReversed();
      return { position: pos, card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright } };
    })
  };
  readingsStore.unshift(reading);
  if (readingsStore.length > 100) readingsStore.pop();
  const lang = getLang(req);
  if (req.body.question) {
    try {
      const aiR = await aiInterpret(reading.cards, req.body.question, lang);
      if (aiR) { reading.interpretation = aiR; reading.interpretationMeta = { theme: '', summary: '', generatedBy: 'ai-zhipu' }; }
      else { const ri = ruleInterpret(reading.cards, req.body.question, lang); reading.interpretation = ri.interpretation; reading.interpretationMeta = { theme: ri.theme, summary: ri.summary, generatedBy: ri.generatedBy }; }
    } catch {
      const ri = ruleInterpret(reading.cards, req.body.question, lang);
      reading.interpretation = ri.interpretation; reading.interpretationMeta = { theme: ri.theme, summary: ri.summary, generatedBy: ri.generatedBy };
    }
  }
  res.json({ success: true, data: reading });
});

// Reading
app.post('/api/reading', (req, res) => {
  const { question, spread: spreadId, cardCount } = req.body;
  let spread = null; let count = cardCount || 1;
  if (spreadId) { spread = data.spreads.find(s => s.id === spreadId); if (!spread) return res.status(400).json({ success: false, error: 'Invalid spread id' }); count = spread.cardCount; }
  const shuffled = [...data.cards].sort(() => Math.random() - 0.5);
  const drawn = shuffled.slice(0, count);
  const isReversed = () => Math.random() > 0.5;
  const result = {
    id: `reading_${Date.now()}`, question: question || null,
    spread: spread ? { id: spread.id, nameZh: spread.nameZh } : null,
    timestamp: new Date().toISOString(),
    cards: drawn.map((card, i) => {
      const reversed = isReversed();
      return { position: spread ? spread.positions[i] : { index: i + 1, nameZh: `第${i + 1}张` }, card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright } };
    })
  };
  readingsStore.unshift(result); if (readingsStore.length > 100) readingsStore.pop();
  res.json({ success: true, data: result });
});

app.post('/api/reading/interpret', async (req, res) => {
  const { cards: inputCards, readingId, question, lang: paramLang } = req.body;
  const lang = paramLang || getLang(req);
  let targetCards;
  if (readingId) { const stored = readingsStore.find(r => r.id === readingId); if (!stored) return res.status(404).json({ success: false, error: 'Reading not found' }); targetCards = stored.cards; }
  else if (inputCards && Array.isArray(inputCards)) targetCards = inputCards;
  else return res.status(400).json({ success: false, error: 'Provide "cards" or "readingId"' });
  let result;
  const aiR = await aiInterpret(targetCards, question || '', lang);
  if (aiR) result = { interpretation: aiR, theme: '', summary: '', generatedBy: 'ai-zhipu' };
  else { const ir = ruleInterpret(targetCards, question || '', lang); result = { interpretation: ir.interpretation, theme: ir.theme, summary: ir.summary, generatedBy: ir.generatedBy }; }
  if (readingId) { const stored = readingsStore.find(r => r.id === readingId); if (stored) { stored.interpretation = result.interpretation; stored.interpretationMeta = { theme: result.theme, summary: result.summary, generatedBy: result.generatedBy }; } }
  res.json({ success: true, data: { ...result, lang } });
});

// History
app.get('/api/readings', (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const p = parseInt(page), l = parseInt(limit), total = readingsStore.length;
  res.json({ success: true, data: readingsStore.slice((p - 1) * l, p * l), pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } });
});
app.get('/api/readings/:id', (req, res) => {
  const reading = readingsStore.find(r => r.id === req.params.id);
  if (!reading) return res.status(404).json({ success: false, error: 'Reading not found' });
  res.json({ success: true, data: reading });
});
app.delete('/api/readings/:id', (req, res) => {
  const idx = readingsStore.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Reading not found' });
  readingsStore.splice(idx, 1);
  res.json({ success: true, message: 'Reading deleted' });
});

// Daily
app.get('/api/daily-card', (_req, res) => {
  const card = data.cards[Math.floor(Math.random() * data.cards.length)];
  const reversed = Math.random() > 0.5;
  res.json({ success: true, data: { date: new Date().toISOString().split('T')[0], card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright, description: card.description } } });
});

// Search
app.get('/api/search', (req, res) => {
  const { q, type = 'all' } = req.query;
  if (!q) return res.status(400).json({ success: false, error: 'Query "q" required' });
  const result = {};
  const kw = q.toLowerCase();
  if (type === 'all' || type === 'cards') {
    result.cards = data.cards.filter(c => c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) || c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw)) || c.meaningUpright.includes(kw) || c.meaningReversed.includes(kw) || c.description.includes(kw)).map(c => ({ id: c.id, nameZh: c.nameZh, nameEn: c.nameEn, image: c.image }));
  }
  if (type === 'all' || type === 'spreads') {
    result.spreads = data.spreads.filter(s => s.nameEn.toLowerCase().includes(kw) || s.nameZh.includes(kw) || s.description.includes(kw));
  }
  res.json({ success: true, data: result });
});

// Questions
app.get('/api/questions', (req, res) => {
  let result = [...data.questions];
  if (req.query.category) result = result.filter(q => q.category === req.query.category);
  res.json({ success: true, data: result });
});
app.post('/api/questions/rewrite', async (req, res) => {
  const { question, lang: paramLang } = req.body;
  if (!question) return res.status(400).json({ success: false, error: 'Field "question" required' });
  const lang = paramLang || getLang(req);
  const aiR = await aiRewriteQ(question, lang);
  if (aiR) return res.json({ success: true, data: { original: question.trim(), rewritten: aiR, changed: aiR !== question.trim(), generatedBy: 'ai-zhipu' } });
  const fr = ruleRewrite(question, lang);
  res.json({ success: true, data: { original: question.trim(), rewritten: fr.rewritten, changed: fr.changed, generatedBy: fr.generatedBy } });
});

// FAQ
app.get('/api/faq', (_req, res) => res.json({ success: true, data: data.faqs }));

// Oracle
app.post('/api/oracle/chat', async (req, res) => {
  const { message, lang: paramLang, history } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Field "message" required' });
  const lang = paramLang || getLang(req);
  let reply = null, generatedBy = 'rule-engine';
  const aiReply = await aiOracle(message, history, lang);
  if (aiReply) { reply = aiReply; generatedBy = 'ai-zhipu'; }
  if (!reply) reply = ruleOracle(message, lang).reply;
  res.json({ success: true, data: { message: reply, lang, generatedBy, timestamp: new Date().toISOString() } });
});

// Stats
app.get('/api/stats', (_req, res) => {
  const suits = {};
  ['wands', 'cups', 'swords', 'pentacles'].forEach(s => { suits[s] = data.cards.filter(c => c.suit === s).length; });
  res.json({ success: true, data: { totalCards: data.cards.length, majorArcana: data.cards.filter(c => c.arcana === 'major').length, minorArcana: data.cards.filter(c => c.arcana === 'minor').length, suits, totalSpreads: data.spreads.length, totalFAQs: data.faqs.length, totalQuestionCategories: data.questions.length, totalReadings: readingsStore.length, llmProvider: 'zhipu' } });
});

export default app;