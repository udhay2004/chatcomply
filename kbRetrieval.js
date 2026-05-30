'use strict';

/**
 * ============================================================
 *  COMPLY GLOBALLY — KB Retrieval (No External API)
 *  Uses BM25 scoring: far better than keyword matching,
 *  zero cost, zero new accounts, runs fully in-process.
 *
 *  HOW IT WORKS:
 *  1. kb.json is loaded once at startup and kept in memory.
 *  2. Each chunk is pre-indexed with term frequencies.
 *  3. Per query: score every chunk with BM25, return top N.
 *  4. Only those chunks (~600-900 tokens) are injected into Claude.
 *
 *  ADD THIS FILE to your GitHub repo root alongside server.js.
 * ============================================================
 */

const fs   = require('fs');
const path = require('path');

const MAX_CHUNKS = parseInt(process.env.KB_MAX_CHUNKS  || '3',   10);
const MIN_SCORE  = parseFloat(process.env.KB_MIN_SCORE || '0.5');

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

let _chunks = [];
let _idf    = {};
let _avgLen = 0;
let _ready  = false;

function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function buildIndex(chunks) {
  const indexed = chunks.map(c => {
    const tokens = tokenise(c.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { ...c, tokens, tf, len: tokens.length };
  });

  const df = {};
  const N  = indexed.length;
  for (const c of indexed) {
    for (const term of c.tf.keys()) df[term] = (df[term] || 0) + 1;
  }

  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
  }

  const avgLen = indexed.reduce((s, c) => s + c.len, 0) / (indexed.length || 1);
  return { indexed, idf, avgLen };
}

function loadKB() {
  if (_ready) return;
  const kbPath = path.join(__dirname, 'kb.json');
  if (!fs.existsSync(kbPath)) {
    console.error('❌  kb.json not found — run: node build-kb.js');
    return;
  }
  try {
    const raw    = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    const result = buildIndex(raw.chunks || []);
    _chunks  = result.indexed;
    _idf     = result.idf;
    _avgLen  = result.avgLen;
    _ready   = true;
    console.log(`✅  KB loaded: ${_chunks.length} chunks indexed`);
  } catch (err) {
    console.error('❌  KB load failed:', err.message);
  }
}

loadKB();

function bm25Score(chunk, queryTerms) {
  let score = 0;
  const norm = 1 - BM25_B + BM25_B * (chunk.len / (_avgLen || 1));
  for (const term of queryTerms) {
    const idf = _idf[term];
    if (!idf) continue;
    const tf  = chunk.tf.get(term) || 0;
    score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
  }
  return score;
}

/**
 * Retrieve the most relevant KB chunks for a user message.
 * Drop-in replacement for selectKBSections(userMessage).
 */
function retrieveKBChunks(userMessage) {
  if (!_ready || !_chunks.length) return '';
  const queryTerms = tokenise(userMessage);
  if (!queryTerms.length) return '';

  const top = _chunks
    .map(c => ({ c, score: bm25Score(c, queryTerms) }))
    .filter(s => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHUNKS);

  if (!top.length) { console.log('ℹ️  No KB chunks matched query'); return ''; }

  console.log(`📚  KB: ${top.length} chunks — scores: ${top.map(s => s.score.toFixed(2)).join(', ')}`);
  console.log(`    Topics: ${top.map(s => `${s.c.jurisdiction}:${s.c.heading}`).join(' | ')}`);

  const sections = top.map(({ c }) =>
    `[${c.jurisdiction.toUpperCase()}${c.heading ? ' — ' + c.heading : ''}]\n${c.text}`
  );

  return '\n\n[KNOWLEDGE BASE — RELEVANT SECTIONS]\n' + sections.join('\n\n---\n\n');
}

module.exports = { retrieveKBChunks };

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','day','get','has','him','his','how','its','may','now','put','too',
  'use','way','who','did','let','she','they','with','this','that','from','have',
  'been','than','then','when','also','into','more','what','your','will','each',
  'just','over','such','some','said','which','their','there','were','about',
  'would','could','other','these','those','should','under','being','since',
  'both','only','very','even','back','after','where','while','make','well',
  'take','here','come','must','most','need','part','time','year','many','upon',
  'does','still','always','within','during','further','before','against','between',
]);
