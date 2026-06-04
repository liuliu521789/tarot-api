import https from 'https';
import http from 'http';

const PROVIDERS = {
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: { default: 'glm-4.7', fast: 'glm-4-flash' } },
  openai: { baseUrl: 'https://api.openai.com/v1', models: { default: 'gpt-4o-mini' } },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', models: { default: 'deepseek-chat' } },
};

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'zhipu';
const LLM_API_KEY = process.env.LLM_API_KEY || 'e5f6ecdf59924cf9a1fab336b3c2802a.lmeBF2S6sNZZK4qm';
const LLM_BASE_URL = PROVIDERS[LLM_PROVIDER]?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
const LLM_MODEL = process.env.LLM_MODEL || PROVIDERS[LLM_PROVIDER]?.models?.default || 'glm-4.7';
const aiEnabled = !!LLM_API_KEY;

export async function callLLM(messages, options = {}) {
  if (!aiEnabled) return null;
  const url = new URL(`${LLM_BASE_URL}/chat/completions`);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  const body = JSON.stringify({ model: options.model || LLM_MODEL, messages, temperature: options.temperature ?? 0.7, max_tokens: options.maxTokens || 2000 });
  return new Promise((resolve, reject) => {
    const req = client.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` }, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { const json = JSON.parse(data); resolve(json.choices?.[0]?.message?.content || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function buildInterpretPrompt(drawnCards, question, lang) {
  const cardsInfo = drawnCards.map((c, i) => {
    const posName = c.position?.nameZh || c.position?.nameEn || `位置${i + 1}`;
    const dir = c.card.reversed ? (lang === 'zh' ? '逆位' : 'Reversed') : (lang === 'zh' ? '正位' : 'Upright');
    return `【${posName}】— ${c.card.nameZh}(${c.card.nameEn}) ${dir}\n关键词: ${(c.card.keywords || []).join('、')}\n牌意: ${c.card.meaning}`;
  }).join('\n\n');
  const sp = lang === 'zh' ? '你是一位资深塔罗解读师，精通韦特塔罗牌。以温柔、诗意的语言解读塔罗牌阵，控制在 500 字以内。' : 'You are a senior tarot reader, expert in Rider-Waite. Provide warm, poetic interpretations under 500 words.';
  const up = lang === 'zh' ? `用户的问题: ${question || '未指定'}\n\n抽到的牌:\n${cardsInfo}\n\n请结合每张牌的含义、位置和正逆位，为用户写一段塔罗解读。` : `Question: ${question || 'None'}\n\nCards:\n${cardsInfo}\n\nProvide a warm tarot reading.`;
  return [{ role: 'system', content: sp }, { role: 'user', content: up }];
}

export async function aiGenerateInterpretation(drawnCards, question, lang = 'zh') {
  if (!aiEnabled) return null;
  return await callLLM(buildInterpretPrompt(drawnCards, question, lang), { temperature: 0.8, maxTokens: 1500 });
}

export async function aiOracleChat(message, history, lang = 'zh') {
  if (!aiEnabled) return null;
  const sp = lang === 'zh' ? '你是一位博学的塔罗牌向导，精通 78 张韦特塔罗牌。温柔、智慧、富有哲理。300 字以内。不给出医疗/法律/财务确定性建议。' : 'You are a knowledgeable tarot oracle. Warm, wise. Under 300 words.';
  return await callLLM([{ role: 'system', content: sp }, ...(Array.isArray(history) ? history.slice(-10) : []), { role: 'user', content: message }], { temperature: 0.85, maxTokens: 800 });
}

export async function aiRewriteQuestion(question, lang = 'zh') {
  if (!aiEnabled) return null;
  const sp = lang === 'zh' ? '将用户问题改写为适合塔罗解读的开放式问题。只返回改写后的问题。' : 'Rewrite into open-ended question for tarot. Return only rewritten question.';
  const result = await callLLM([{ role: 'system', content: sp }, { role: 'user', content: `改写: "${question}"` }], { temperature: 0.5, maxTokens: 200 });
  return result?.trim() || null;
}

export function generateSpreadInterpretation(drawnCards, question, lang = 'zh') {
  const cardDescriptions = drawnCards.map(c => {
    const posName = c.position?.nameZh || c.position?.nameEn || `位置${c.position?.index || '?'}`;
    return `【${posName}】${c.card.nameZh}(${c.card.reversed ? '逆位' : '正位'}): ${c.card.meaning}`;
  });
  const majorCount = drawnCards.filter(c => { const id = c.card.id; return id.length <= 5 || id.startsWith('0') || id.startsWith('1'); }).length;
  const reversedCount = drawnCards.filter(c => c.card.reversed).length;
  let theme = '';
  if (majorCount >= 2) theme = lang === 'zh' ? '多张大阿卡纳出现，触及人生核心课题。' : 'Multiple Major Arcana cards appear.';
  else if (majorCount === 1) theme = lang === 'zh' ? '大阿卡纳能量主导，关注重要转折。' : 'Major Arcana energy guides.';
  else theme = lang === 'zh' ? '小阿卡纳聚焦日常事务与情感体验。' : 'Minor Arcana focuses on daily matters.';
  let reverseNote = '';
  if (reversedCount > 0) reverseNote = lang === 'zh' ? '\n\n有逆位牌出现，提醒放慢脚步重新审视。' : '\n\nSome reversed cards, slow down.';
  return { interpretation: `${theme}\n\n${cardDescriptions.join('\n\n')}\n\n【综合解读】保持开放心态，相信直觉。${reverseNote}`, theme, summary: drawnCards.flatMap(c => c.card.keywords || []).slice(0, 8).join('、'), generatedBy: 'rule-engine' };
}

export function generateOracleResponse(message, lang = 'zh') {
  const responses = {
    love: lang === 'zh' ? '关于感情，塔罗提醒我们：每段关系都是内在状态的镜子。学会爱自己，健康的爱情自然会流向你。' : 'Regarding love, relationships mirror our inner state.',
    career: lang === 'zh' ? '事业困惑源于与使命感的连接。塔罗帮你看清职业能量和潜在机会。真正的成功是内在满足与成长。' : 'Career confusion connects to purpose.',
    growth: lang === 'zh' ? '自我成长是灵魂最深的渴望。迷茫是一个邀请——停下来倾听内心。塔罗反射你人生旅程的阶段。' : 'Self-growth is the deepest desire.',
    card: lang === 'zh' ? '塔罗是 78 张牌的智慧系统，22 张大阿卡纳和 56 张小阿卡纳。可通过牌库浏览或直接占卜获得指引。' : 'Tarot has 78 cards.',
    general: lang === 'zh' ? '塔罗是一面镜子，反射你内心的智慧。答案早已在你心中，塔罗帮你拨开迷雾看见它。' : 'The tarot mirrors inner wisdom.'
  };
  const msg = message.toLowerCase();
  const patterns = { love: ['爱', '感情', '关系', '恋情', '分手'], career: ['工作', '事业', '职业', '升职', '创业'], growth: ['成长', '迷茫', '人生', '方向'], card: ['牌', '塔罗', '牌阵'] };
  for (const [topic, keywords] of Object.entries(patterns)) { if (keywords.some(k => msg.includes(k))) return { reply: responses[topic], topic, generatedBy: 'rule-engine' }; }
  return { reply: responses.general, topic: 'general', generatedBy: 'rule-engine' };
}

export function rewriteQuestion(original, lang = 'zh') {
  if (!original || !original.trim()) return { rewritten: original || '', generatedBy: 'rule-engine', changed: false };
  let q = original.trim();
  if (!/[?？]$/.test(q)) q += '？';
  const replacements = [[/他会不会/gi, '我是否有可能'], [/她会不会/gi, '我是否有可能'], [/我会不会/gi, '我是否能够'], [/能不能/gi, '如何能够'], [/怎么办/gi, '应该如何应对'], [/行不行/gi, '是否可行'], [/该不该/gi, '是否应该'], [/好不好/gi, '是否适宜'], [/帮我/gi, '请指引我'], [/告诉我/gi, '请指引我了解'], [/我应该/gi, '在当前情况下，我是否可以']];
  let changed = false;
  for (const [p, r] of replacements) { if (p.test(q)) { q = q.replace(p, r); changed = true; } }
  return { rewritten: q, generatedBy: 'rule-engine', changed };
}