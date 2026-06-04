import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  generateSpreadInterpretation,
  generateOracleResponse,
  rewriteQuestion,
  aiGenerateInterpretation,
  aiOracleChat,
  aiRewriteQuestion
} from '../llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// Load data from adjacent data directory
const dataDir = path.join(__dirname, '..', 'data');
const cards = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8'));
const spreads = JSON.parse(fs.readFileSync(path.join(dataDir, 'spreads.json'), 'utf-8'));
const faqs = JSON.parse(fs.readFileSync(path.join(dataDir, 'faq.json'), 'utf-8'));
const questions = JSON.parse(fs.readFileSync(path.join(dataDir, 'questions.json'), 'utf-8'));

const readingsStore = [];

function getLang(req) {
  const lang = req.query.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'zh';
  return ['zh', 'en'].includes(lang) ? lang : 'zh';
}

// ============ Cards API ============
app.get('/api/cards', (req, res) => {
  let result = [...cards];
  const { arcana, suit, element, court, keyword, page = 1, limit = 78 } = req.query;
  if (arcana) result = result.filter(c => c.arcana === arcana);
  if (suit) result = result.filter(c => c.suit === suit);
  if (element) result = result.filter(c => c.element === element);
  if (court) result = result.filter(c => c.court === court);
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(c =>
      c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) ||
      c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw)) ||
      c.meaningUpright.includes(kw) || c.meaningReversed.includes(kw)
    );
  }
  const p = parseInt(page), l = parseInt(limit), total = result.length;
  const paginated = result.slice((p - 1) * l, p * l);
  res.json({ success: true, data: paginated, pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } });
});

app.get('/api/cards/major-arcana', (_req, res) => {
  res.json({ success: true, data: cards.filter(c => c.arcana === 'major'), total: cards.filter(c => c.arcana === 'major').length });
});

app.get('/api/cards/suit/:suit', (req, res) => {
  const validSuits = ['wands', 'cups', 'swords', 'pentacles'];
  const suit = req.params.suit.toLowerCase();
  if (!validSuits.includes(suit)) return res.status(400).json({ success: false, error: `Invalid suit` });
  const result = cards.filter(c => c.suit === suit);
  res.json({ success: true, data: result, total: result.length });
});

app.get('/api/cards/random', (req, res) => {
  let pool = [...cards];
  const { count = 1, arcana, suit } = req.query;
  if (arcana) pool = pool.filter(c => c.arcana === arcana);
  if (suit) pool = pool.filter(c => c.suit === suit);
  const c = Math.min(parseInt(count), pool.length);
  res.json({ success: true, data: pool.sort(() => Math.random() - 0.5).slice(0, c) });
});

app.get('/api/cards/:id', (req, res) => {
  const card = cards.find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ success: false, error: 'Card not found' });
  res.json({ success: true, data: card });
});

// ============ Spreads API ============
app.get('/api/spreads', (req, res) => {
  let result = [...spreads];
  if (req.query.category) result = result.filter(s => s.category === req.query.category);
  res.json({ success: true, data: result, total: result.length });
});

app.get('/api/spreads/:id', (req, res) => {
  const spread = spreads.find(s => s.id === req.params.id);
  if (!spread) return res.status(404).json({ success: false, error: 'Spread not found' });
  res.json({ success: true, data: spread });
});

app.post('/api/spreads/:id/draw', async (req, res) => {
  const spread = spreads.find(s => s.id === req.params.id);
  if (!spread) return res.status(404).json({ success: false, error: 'Spread not found' });
  const shuffled = [...cards].sort(() => Math.random() - 0.5);
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
      const aiResult = await aiGenerateInterpretation(reading.cards, req.body.question, lang);
      if (aiResult) { reading.interpretation = aiResult; reading.interpretationMeta = { theme: '', summary: '', generatedBy: 'ai-zhipu' }; }
      else throw new Error('AI null');
    } catch {
      const ri = generateSpreadInterpretation(reading.cards, req.body.question, lang);
      reading.interpretation = ri.interpretation; reading.interpretationMeta = { theme: ri.theme, summary: ri.summary, generatedBy: ri.generatedBy };
    }
  }
  res.json({ success: true, data: reading });
});

// ============ Reading API ============
app.post('/api/reading', (req, res) => {
  const { question, spread: spreadId, cardCount } = req.body;
  let spread = null; let count = cardCount || 1;
  if (spreadId) { spread = spreads.find(s => s.id === spreadId); if (!spread) return res.status(400).json({ success: false, error: 'Invalid spread id' }); count = spread.cardCount; }
  const shuffled = [...cards].sort(() => Math.random() - 0.5);
  const drawn = shuffled.slice(0, count);
  const isReversed = () => Math.random() > 0.5;
  const result = { id: `reading_${Date.now()}`, question: question || null, spread: spread ? { id: spread.id, nameZh: spread.nameZh } : null, timestamp: new Date().toISOString(), cards: drawn.map((card, i) => { const reversed = isReversed(); return { position: spread ? spread.positions[i] : { index: i + 1, nameZh: `第${i + 1}张` }, card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright } }; }) };
  readingsStore.unshift(result); if (readingsStore.length > 100) readingsStore.pop();
  res.json({ success: true, data: result });
});

app.post('/api/reading/interpret', async (req, res) => {
  const { cards: inputCards, readingId, question, lang: paramLang } = req.body;
  const lang = paramLang || getLang(req);
  let targetCards;
  if (readingId) { const stored = readingsStore.find(r => r.id === readingId); if (!stored) return res.status(404).json({ success: false, error: 'Reading not found' }); targetCards = stored.cards; }
  else if (inputCards && Array.isArray(inputCards)) targetCards = inputCards;
  else return res.status(400).json({ success: false, error: 'Provide "cards" array or "readingId"' });
  let result;
  const aiResult = await aiGenerateInterpretation(targetCards, question || '', lang);
  if (aiResult) result = { interpretation: aiResult, theme: '', summary: '', generatedBy: 'ai-zhipu' };
  else { const ir = generateSpreadInterpretation(targetCards, question || '', lang); result = { interpretation: ir.interpretation, theme: ir.theme, summary: ir.summary, generatedBy: ir.generatedBy }; }
  if (readingId) { const stored = readingsStore.find(r => r.id === readingId); if (stored) { stored.interpretation = result.interpretation; stored.interpretationMeta = { theme: result.theme, summary: result.summary, generatedBy: result.generatedBy }; } }
  res.json({ success: true, data: { interpretation: result.interpretation, theme: result.theme, summary: result.summary, generatedBy: result.generatedBy, lang } });
});

// ============ History API ============
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

// ============ Daily Card ============
app.get('/api/daily-card', (_req, res) => {
  const card = cards[Math.floor(Math.random() * cards.length)];
  const reversed = Math.random() > 0.5;
  res.json({ success: true, data: { date: new Date().toISOString().split('T')[0], card: { id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, image: card.image, reversed, keywords: reversed ? card.keywordsReversed : card.keywordsUpright, meaning: reversed ? card.meaningReversed : card.meaningUpright, description: card.description } } });
});

// ============ Search ============
app.get('/api/search', (req, res) => {
  const { q, type = 'all' } = req.query;
  if (!q) return res.status(400).json({ success: false, error: 'Query "q" required' });
  const result = {};
  if (type === 'all' || type === 'cards') {
    const kw = q.toLowerCase();
    result.cards = cards.filter(c => c.nameEn.toLowerCase().includes(kw) || c.nameZh.includes(kw) || c.keywordsUpright.some(k => k.includes(kw)) || c.keywordsReversed.some(k => k.includes(kw)) || c.meaningUpright.includes(kw) || c.meaningReversed.includes(kw) || c.description.includes(kw)).map(c => ({ id: c.id, nameZh: c.nameZh, nameEn: c.nameEn, image: c.image }));
  }
  if (type === 'all' || type === 'spreads') {
    const kw = q.toLowerCase();
    result.spreads = spreads.filter(s => s.nameEn.toLowerCase().includes(kw) || s.nameZh.includes(kw) || s.description.includes(kw));
  }
  res.json({ success: true, data: result });
});

// ============ Questions ============
app.get('/api/questions', (req, res) => {
  let result = [...questions];
  if (req.query.category) result = result.filter(q => q.category === req.query.category);
  res.json({ success: true, data: result });
});
app.post('/api/questions/rewrite', async (req, res) => {
  const { question, lang: paramLang } = req.body;
  if (!question) return res.status(400).json({ success: false, error: 'Field "question" is required' });
  const lang = paramLang || getLang(req);
  const aiRewritten = await aiRewriteQuestion(question, lang);
  if (aiRewritten) return res.json({ success: true, data: { original: question.trim(), rewritten: aiRewritten, changed: aiRewritten !== question.trim(), generatedBy: 'ai-zhipu' } });
  const fr = rewriteQuestion(question, lang);
  res.json({ success: true, data: { original: question.trim(), rewritten: fr.rewritten, changed: fr.changed, generatedBy: fr.generatedBy } });
});

// ============ FAQ ============
app.get('/api/faq', (_req, res) => res.json({ success: true, data: faqs }));

// ============ Oracle Chat ============
app.post('/api/oracle/chat', async (req, res) => {
  const { message, lang: paramLang, history } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Field "message" is required' });
  const lang = paramLang || getLang(req);
  let reply = null, generatedBy = 'rule-engine';
  const aiReply = await aiOracleChat(message, history, lang);
  if (aiReply) { reply = aiReply; generatedBy = 'ai-zhipu'; }
  if (!reply) reply = generateOracleResponse(message, lang).reply;
  res.json({ success: true, data: { message: reply, lang, generatedBy, timestamp: new Date().toISOString() } });
});

// ============ Stats ============
app.get('/api/stats', (_req, res) => {
  const suits = {}; ['wands', 'cups', 'swords', 'pentacles'].forEach(s => { suits[s] = cards.filter(c => c.suit === s).length; });
  res.json({ success: true, data: { totalCards: cards.length, majorArcana: cards.filter(c => c.arcana === 'major').length, minorArcana: cards.filter(c => c.arcana === 'minor').length, suits, totalSpreads: spreads.length, totalFAQs: faqs.length, totalQuestionCategories: questions.length, totalReadings: readingsStore.length, llmProvider: process.env.LLM_PROVIDER || 'zhipu' } });
});

// ============ Health ============
app.get('/api/health', (_req, res) => res.json({ success: true, message: 'Tarot API running', timestamp: new Date().toISOString() }));

app.get('/', (_req, res) => res.json({ name: 'Tarot.run API', version: '3.0.0', description: '塔罗牌占卜后端接口服务', endpoints: { cards: '/api/cards', spreads: '/api/spreads', reading: '/api/reading', history: '/api/readings', daily: '/api/daily-card', search: '/api/search', questions: '/api/questions', oracle: '/api/oracle/chat', faq: '/api/faq', stats: '/api/stats', health: '/api/health' } }));

export default app;