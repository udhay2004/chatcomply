const express = require('express');
const path    = require('path');
const fetch   = require('node-fetch');
const { MongoClient } = require('mongodb');
const { google }      = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow WordPress site to call this backend (CORS)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────
// ENV — all values come from Render dashboard
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY  = (process.env.ANTHROPIC_API_KEY  || '').trim();
const MONGODB_URI        = (process.env.MONGODB_URI        || '').trim();
const GOOGLE_SHEET_ID    = (process.env.GOOGLE_SHEET_ID    || '').trim();
const GOOGLE_CREDENTIALS = (process.env.GOOGLE_CREDENTIALS || '').trim();
const RESEND_API_KEY     = (process.env.RESEND_API_KEY     || '').trim();
const NOTIFY_EMAIL       = (process.env.NOTIFY_EMAIL       || 'sales@complyglobally.com').trim();
const FROM_EMAIL         = (process.env.FROM_EMAIL         || 'Comply Bot <onboarding@resend.dev>').trim();
const KEEP_ALIVE_URL     = (process.env.KEEP_ALIVE_URL     || '').trim();

// Startup check — shows in Render logs
[
  ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
  ['MONGODB_URI',       MONGODB_URI],
  ['GOOGLE_SHEET_ID',   GOOGLE_SHEET_ID],
  ['RESEND_API_KEY',    RESEND_API_KEY],
].forEach(([k, v]) => {
  if (!v) console.error(`❌ ${k} missing!`);
  else    console.log(`✅ ${k} loaded`);
});

// ─────────────────────────────────────────────
// KEEP-ALIVE — pings /health every 14 min
// ─────────────────────────────────────────────
function startKeepAlive() {
  const url = KEEP_ALIVE_URL || `http://localhost:${process.env.PORT || 5000}/health`;
  console.log(`💓 Keep-alive will ping: ${url}`);
  setInterval(async () => {
    try {
      await fetch(url);
      console.log(`💓 Keep-alive OK — ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      console.warn('⚠️ Keep-alive failed:', e.message);
    }
  }, 14 * 60 * 1000);
}

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
let sessionsCol;
let leadsCol;

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️ No MONGODB_URI — running without DB'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db    = client.db('comply_globally');
    sessionsCol = db.collection('web_sessions');
    leadsCol    = db.collection('leads');
    await sessionsCol.createIndex({ sessionId: 1 }, { unique: true });
    await sessionsCol.createIndex({ lastActive: 1 }, { expireAfterSeconds: 86400 });
    await leadsCol.createIndex({ email: 1 });
    await leadsCol.createIndex({ phone: 1 });
    console.log('✅ MongoDB connected — db: comply_globally, leads collection shared');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
  }
}

function freshSession(sessionId) {
  return {
    sessionId,
    history: [],
    leadData: {
      name:                null,
      email:               null,
      phone:               null,
      currentCountry:      null,
      targetCountry:       null,
      serviceNeeded:       null,
      businessStage:       null,
      timeline:            null,
      documentsRequired:   null,
    },
    leadSaved:        false,
    humanRequested:   false,
    createdAt:        new Date(),
    lastActive:       new Date(),
  };
}

const memSessions = {};

async function getSession(sessionId) {
  if (sessionsCol) {
    let s = await sessionsCol.findOne({ sessionId });
    if (!s) {
      s = freshSession(sessionId);
      await sessionsCol.insertOne(s);
    }
    return s;
  }
  if (!memSessions[sessionId]) memSessions[sessionId] = freshSession(sessionId);
  return memSessions[sessionId];
}

async function saveSession(session) {
  session.lastActive = new Date();
  if (sessionsCol) {
    await sessionsCol.replaceOne({ sessionId: session.sessionId }, session, { upsert: true });
  } else {
    memSessions[session.sessionId] = session;
  }
}

// ─────────────────────────────────────────────
// CROSS-DEVICE LEAD DEDUPLICATION
// ─────────────────────────────────────────────
async function findExistingLead(leadData) {
  if (!leadsCol) return null;
  if (leadData.email) {
    const byEmail = await leadsCol.findOne({ email: leadData.email });
    if (byEmail) return byEmail;
  }
  if (leadData.phone) {
    const byPhone = await leadsCol.findOne({ phone: leadData.phone });
    if (byPhone) return byPhone;
  }
  return null;
}

async function saveLead(leadData) {
  if (!leadsCol) return;
  try {
    const existing = await findExistingLead(leadData);
    if (existing) {
      const updatedLead = { ...existing, ...leadData, lastUpdated: new Date() };
      await leadsCol.replaceOne({ _id: existing._id }, updatedLead);
      console.log(`✅ Lead updated (cross-device): ${leadData.email || leadData.phone}`);
    } else {
      await leadsCol.insertOne({
        ...leadData,
        source:      'website',
        createdAt:   new Date(),
        lastUpdated: new Date(),
      });
      console.log(`✅ Lead saved to MongoDB: ${leadData.name || leadData.email}`);
    }
  } catch (err) {
    console.error('❌ Error saving lead:', err.message);
  }
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────────
async function appendToSheet(leadData) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CREDENTIALS) {
    console.warn('⚠️ Skipping Sheets — missing credentials');
    return;
  }
  try {
    const creds  = JSON.parse(GOOGLE_CREDENTIALS);
    const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1:A1' });
    if (!existing.data.values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
        requestBody: { values: [['Timestamp','Source','Name','Email','Phone','Current Country','Target Country','Service','Stage','Timeline','Documents Required']] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
      requestBody: { values: [[
        now, 'Website',
        leadData.name || '', leadData.email || '', leadData.phone || '',
        leadData.currentCountry || '', leadData.targetCountry || '',
        leadData.serviceNeeded || '', leadData.businessStage || '', leadData.timeline || '',
        leadData.documentsRequired || '',
      ]] },
    });
    console.log('✅ Lead written to Google Sheet');
  } catch (err) {
    console.error('❌ Sheets error:', err.message);
  }
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
async function sendEmail({ subject, html }) {
  if (!RESEND_API_KEY) { console.warn('⚠️ No RESEND_API_KEY'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function sendNewLeadEmail(leadData) {
  try {
    await sendEmail({
      subject: `🌐 New Website Lead — ${leadData.name || 'Unknown'}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#0d3b2e;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">🌍 New Lead from Comply Website</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #ddd;border-radius:0 0 8px 8px">
            <table style="width:100%;border-collapse:collapse">
              ${[
                ['Name', leadData.name],
                ['Email', leadData.email],
                ['Phone', leadData.phone],
                ['Based In', leadData.currentCountry],
                ['Target Country', leadData.targetCountry],
                ['Service', leadData.serviceNeeded],
                ['Stage', leadData.businessStage],
                ['Timeline', leadData.timeline],
                ['Documents Required', leadData.documentsRequired],
              ].map(([k,v], i) => `
                <tr style="background:${i%2===0?'#fff':'#f5f5f5'}">
                  <td style="padding:9px 12px;color:#666;width:140px">${k}</td>
                  <td style="padding:9px 12px"><b>${v || '—'}</b></td>
                </tr>`).join('')}
            </table>
            <p style="color:#888;font-size:12px;margin-top:16px">Saved to MongoDB + Google Sheet</p>
          </div>
        </div>
      `
    });
    console.log('📧 Lead email sent');
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Comply, a warm and professional Global Expansion Assistant for Connect Ventures Inc. (brand: Comply Globally). You help entrepreneurs, startups, and businesses establish foreign corporations and expand internationally via the company website chat.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT COMPLY GLOBALLY
━━━━━━━━━━━━━━━━━━━━━━━━━━
Headquarters: Delaware, USA

CORE SERVICES (6):
1. Foreign Corporation Formation – Incorporation in foreign countries across 47+ jurisdictions
2. Banking & Finance – Corporate accounts, cross-border payments, financial structuring
3. International Tax & Secretarial Compliance – IRS/GST/VAT filings, corporate tax, transfer pricing, annual secretarial
4. EXIM – Import/export licensing, trade documentation, customs advisory
5. Investment Advisory – For businesses and startups seeking growth capital
6. Residency & Golden Visas – Investment-linked residency programs (NOT travel visas)

COUNTRIES SERVED (47+ jurisdictions):
Americas: USA (Delaware, Wyoming, Florida, Nevada), Canada (Ontario, British Columbia)
Middle East & Africa: UAE, Saudi Arabia, Egypt, Nigeria, Mauritius, Bahrain, Kuwait, Oman, Qatar
Europe: UK, Netherlands, Germany, France, Italy, Spain, Portugal, Ireland, Luxembourg, Cyprus, Malta, Belgium, Austria, Sweden, Poland, Denmark
Asia-Pacific: India, Singapore, Hong Kong, Indonesia, Thailand, Malaysia, Philippines, Vietnam, South Korea, Japan, Australia, New Zealand

━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED DOCUMENTS (Standard)
━━━━━━━━━━━━━━━━━━━━━━━━━━
For foreign corporation formation, we typically need:
✓ Scanned Copy of Passport – All four corners must be visible
✓ Recent Bank E-Statement – Not older than 45 days (address proof)
✓ Scanned PAN and Aadhar Card Copy – For Indian directors/shareholders
✓ Business Plan Outline – Your vision and expansion strategy
✓ Initial Capital Details – Shareholding structure and investment amount

(Specific requirements vary by jurisdiction — our experts will confirm what you need)

━━━━━━━━━━━━━━━━━━━━━━━━━━
FIRST MESSAGE BEHAVIOR (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━
When this is the first user message in the conversation, ALWAYS start with this exact opening (naturally conversational, grammatically polished):

"Hi there! 👋 I'm Comply, your Global Expansion Assistant from Comply Globally. We specialize in Foreign Corporation Formation, Banking & Finance, International Tax & Secretarial Compliance, EXIM, Investment Advisory, and Residency & Golden Visas—spanning 47+ countries worldwide. I'd love to help you expand globally!

Where are you currently based, and what should I call you?"

This is your ONLY introduction. Do not repeat it in subsequent messages.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION GOALS (AFTER FIRST MESSAGE)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Have a natural, consultative conversation and collect these details gradually (do NOT ask all at once):
✅ Full Name | ✅ Email address | ✅ Phone number | ✅ Current country | ✅ Target country | ✅ Service needed | ✅ Business stage | ✅ Timeline

Once you have the CORE FOUR (Name + Email + Current Country + Target Country), end the conversation warmly with:

"Thank you [Name]! Our expert team will review your profile and reach out to you at [email] within 24 hours. 

You can also contact us directly:
📧 sales@complyglobally.com
📞 +1 (302) 214-1717 | +91 99999 81613

We're excited to help you expand globally! 🎉"

━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN HANDOFF RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━
If the user asks to speak with a person, agent, human, or expert:
1. If you don't have their name yet, ask: "Of course! May I have your name first so our team knows who to reach out to?"
2. Once you have their name, ask: "Is there anything specific you'd like to share with our expert beforehand—such as the country you're targeting or the service you need?"
3. Then confirm: "Perfect! Our team will reach out to you shortly. You can also contact us directly at sales@complyglobally.com or call +1 (302) 214-1717 / +91 99999 81613. 😊"

━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE & COMMUNICATION GUIDELINES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Keep replies concise (2-4 lines). This is a website chat, not an email exchange.
- Use a warm, consultative tone—like a knowledgeable business advisor, never like a form or checklist.
- Extract information naturally from the conversation flow; do not ask pointed questions in rapid succession.
- If asked about documents, mention the standard requirements listed above.
- If asked for contact details: sales@complyglobally.com | +1 (302) 214-1717 | +91 99999 81613
- For specific legal or tax advice → respond with: "Our experts will guide you on the specifics"
- For pricing questions → respond with: "Our team will send you a custom quote based on your jurisdiction and requirements"
- Never guarantee approval timelines or outcomes`;

// ─────────────────────────────────────────────
// LEAD EXTRACTION  (hardened name detection)
// ─────────────────────────────────────────────

// Words that must NEVER be captured as a name
const NAME_BLOCKLIST = new Set([
  // greetings / fillers
  'hi','hello','hey','there','good','well','yes','no','ok','okay','sure','please','thanks','thank',
  'sir','madam','dear','myself','my',
  // service / business vocabulary
  'incorporation','incorporate','formation','company','companies','business','businesses','entity',
  'register','registration','foreign','corpor','corporation','startup','freelancer','consultant',
  'expand','expansion','expanding','setup','set','open','start','establish','form',
  'banking','finance','tax','compliance','secretarial','exim','import','export','residency','visa',
  'investment','advisory','annual','maintenance',
  // countries / regions (common ones)
  'india','uae','dubai','abu dhabi','usa','uk','singapore','canada','hongkong','germany','france',
  'australia','netherlands','ireland','malta','cyprus','mauritius','bahrain','qatar',
  'kuwait','oman','saudi','nigeria','egypt','indonesia','thailand','malaysia','vietnam',
  'philippines','korea','japan','newzealand','ontario','delaware','wyoming','florida','nevada',
  // generic descriptors
  'based','from','in','at','looking','want','need','just','not','with','for','about','some',
  'new','old','small','large','big','medium','early','late','soon','asap','today',
  'agent','human','person','someone','expert','team','support','help','contact',
]);

function extractLeadData(session, userMessage) {
  const lead = session.leadData;
  const msg  = userMessage.toLowerCase().trim();

  // ── NAME (strict blocklist + structure guard) ──────────────────────
  if (!lead.name) {
    const namePatterns = [
      /(?:my name is|i'm|i am|this is|call me|name's)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i,
      /^([A-Za-z]+(?:\s+[A-Za-z]+){1,2})\s*(?:here|,|$)/i,
    ];
    for (const pattern of namePatterns) {
      const match = userMessage.match(pattern);
      if (match) {
        const candidate = match[1].trim();
        const words = candidate.split(/\s+/);
        // Reject if ANY word is in the blocklist, or if any word > 14 chars (likely a keyword)
        const isClean = words.every(w => !NAME_BLOCKLIST.has(w.toLowerCase()) && w.length <= 14);
        // Also reject if the candidate is a single very-common English word (< 3 chars)
        if (isClean && candidate.length >= 2) {
          lead.name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          console.log('📝 Name:', lead.name);
          break;
        }
      }
    }
  }

  // ── EMAIL ──────────────────────────────────────────────────────────────────
  if (!lead.email) {
    const m = userMessage.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m) { lead.email = m[0]; console.log('📝 Email:', lead.email); }
  }

  // ── PHONE ─────────────────────────────────────────────────────────────────
  if (!lead.phone) {
    const m = userMessage.match(/(?:\+?\d[\d\s\-]{8,14}\d)/);
    if (m) {
      const cleaned = m[0].replace(/[\s\-]/g, '');
      if (cleaned.length >= 10) { lead.phone = cleaned; console.log('📝 Phone:', lead.phone); }
    }
  }

  // ── COUNTRIES ─────────────────────────────────────────────────────────
  const countries = [
    'vietnam','india','uae','dubai','abu dhabi','usa','united states','america','uk','united kingdom','britain','england',
    'singapore','hong kong','canada','netherlands','holland','saudi arabia','saudi','mauritius','egypt','nigeria','indonesia',
    'thailand','malaysia','philippines','germany','france','italy','spain','portugal','ireland','luxembourg','cyprus','malta',
    'bahrain','kuwait','oman','qatar','belgium','austria','sweden','poland','denmark','south korea','korea','japan','australia',
    'new zealand','wyoming','nevada','florida','ontario','british columbia',
  ];
  const countryMap = {
    'dubai':'UAE','abu dhabi':'UAE','america':'USA','united states':'USA','britain':'UK','england':'UK',
    'united kingdom':'UK','holland':'Netherlands','saudi':'Saudi Arabia','korea':'South Korea',
  };
  const expansionKw = ['expand to','expanding to','open in','setup in','set up in','register in','incorporate in','start in','move to','moving to','want to go','looking to expand','planning to','want to open','establish in','form in'];
  const currentKw   = ['based in','currently based','i am in',"i'm in",'living in','located in','from','we are from','our office'];
  const isExpansion = expansionKw.some(k => msg.includes(k));
  const isCurrent   = currentKw.some(k => msg.includes(k));

  for (const c of countries) {
    if (!msg.includes(c)) continue;
    const mapped = countryMap[c] || c.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    if (isExpansion && !lead.targetCountry)     { lead.targetCountry  = mapped; console.log('📝 Target:', mapped); break; }
    else if (isCurrent && !lead.currentCountry) { lead.currentCountry = mapped; console.log('📝 Current:', mapped); break; }
    else if (!lead.currentCountry)              { lead.currentCountry = mapped; console.log('📝 Current (inferred):', mapped); break; }
    else if (!lead.targetCountry)               { lead.targetCountry  = mapped; console.log('📝 Target (inferred):', mapped); break; }
  }

  // ── SERVICE ───────────────────────────────────────────────────────────────
  if (!lead.serviceNeeded) {
    if      (msg.match(/compan|incorporat|formation|register|llc|llp|pvt|entity|business setup|foreign|corpor/))
      lead.serviceNeeded = 'Foreign Corporation Formation';
    else if (msg.match(/bank|account|finance|payment/))
      lead.serviceNeeded = 'Banking & Finance';
    else if (msg.match(/tax|vat|gst|irs|filing|compliance|secretarial/))
      lead.serviceNeeded = 'International Tax & Secretarial Compliance';
    else if (msg.match(/exim|import|export|trade|customs/))
      lead.serviceNeeded = 'EXIM';
    else if (msg.match(/invest|growth|capital|funding/))
      lead.serviceNeeded = 'Investment Advisory';
    else if (msg.match(/visa|residency|golden visa/))
      lead.serviceNeeded = 'Residency & Golden Visas';
    else if (msg.match(/annual|maintenance|renewal/))
      lead.serviceNeeded = 'Annual Maintenance';
    if (lead.serviceNeeded) console.log('📝 Service:', lead.serviceNeeded);
  }

  // ── STAGE ─────────────────────────────────────────────────────────────────
  if (!lead.businessStage) {
    if      (msg.match(/startup|start.?up|just start|new business|early/)) lead.businessStage = 'Startup';
    else if (msg.match(/freelanc|independ|consultant|solo/))               lead.businessStage = 'Freelancer';
    else if (msg.match(/sme|small.?medium|small business/))                lead.businessStage = 'SME';
    else if (msg.match(/established|enterprise|corporat|large|mnc/))       lead.businessStage = 'Established';
    if (lead.businessStage) console.log('📝 Stage:', lead.businessStage);
  }

  // ── TIMELINE ──────────────────────────────────────────────────────────
  if (!lead.timeline) {
    const tm = msg.match(/(\d+)\s*(?:month|week|year)/);
    if (tm) {
      const n = parseInt(tm[1]);
      if      (msg.includes('week') && n <= 2) lead.timeline = 'Immediately';
      else if (msg.includes('week'))           lead.timeline = 'Within 1 month';
      else if (n <= 1)                         lead.timeline = 'Within 1 month';
      else if (n <= 3)                         lead.timeline = '1-3 months';
      else if (n <= 6)                         lead.timeline = '3-6 months';
      else                                     lead.timeline = '6+ months';
    } else if (msg.match(/asap|urgent|immediately|right now|today/)) lead.timeline = 'Immediately';
    else if   (msg.match(/this month|soon|shortly/))                  lead.timeline = 'Within 1 month';
    if (lead.timeline) console.log('📝 Timeline:', lead.timeline);
  }

  // ── DOCUMENTS ─────────────────────────────────────────────────────────
  if (!lead.documentsRequired) {
    if (msg.match(/document|passport|bank|statement|pan|aadhar|business plan|capital/)) {
      lead.documentsRequired = 'Passport, Bank Statement, PAN, Aadhar, Business Plan, Capital Details';
      console.log('📝 Documents:', lead.documentsRequired);
    }
  }

  // ── HUMAN HANDOFF FLAG ────────────────────────────────────────────────────
  if (!session.humanRequested) {
    if (msg.match(/speak to|talk to|connect (me )?with|transfer|human|agent|person|expert|representative|real person|someone/)) {
      session.humanRequested = true;
      console.log('🤝 Human handoff requested');
    }
  }
}

function isCoreLeadComplete(lead) {
  return !!(lead.name && lead.email && lead.currentCountry && lead.targetCountry);
}

// ─────────────────────────────────────────────
// CLAUDE AI
// ─────────────────────────────────────────────
async function getClaudeReply(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  const l = session.leadData;
  const known = [
    l.name           && `Name: ${l.name}`,
    l.email          && `Email: ${l.email}`,
    l.phone          && `Phone: ${l.phone}`,
    l.currentCountry && `Based in: ${l.currentCountry}`,
    l.targetCountry  && `Target: ${l.targetCountry}`,
    l.serviceNeeded  && `Service: ${l.serviceNeeded}`,
    l.businessStage  && `Stage: ${l.businessStage}`,
    l.timeline       && `Timeline: ${l.timeline}`,
  ].filter(Boolean);

  const contextNote = known.length
    ? `\n\n[CUSTOMER CONTEXT — already known, do NOT re-ask these: ${known.join(' | ')}]`
    : '';

  // Inject human-handoff instruction if flagged
  const handoffNote = session.humanRequested
    ? `\n\n[HANDOFF FLAG: User has asked to speak with a human/agent. Follow the HUMAN HANDOFF RULE exactly. Collect their name if missing, ask for any extra info, then confirm the team will reach out.]`
    : '';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: SYSTEM_PROMPT + contextNote + handoffNote,
        messages: session.history,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || "I'm having a small issue — please try again in a moment. 🙏";

    session.history.push({ role: 'assistant', content: reply });
    return reply;

  } catch (err) {
    console.error('❌ Claude error:', err.message);
    return "I'm having a technical issue. Please email us at sales@complyglobally.com 🙏";
  }
}

// ─────────────────────────────────────────────
// MAIN CHAT ENDPOINT
// ─────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!message) return res.json({ reply: 'Please send a message.' });

    if (!sessionId) {
      sessionId = 'web_' + Math.random().toString(36).slice(2) + '_' + Date.now();
    }

    const session = await getSession(sessionId);
    extractLeadData(session, message);

    const reply = await getClaudeReply(session, message);

    // Save lead the first time core info is complete
    if (!session.leadSaved && isCoreLeadComplete(session.leadData)) {
      session.leadSaved = true;
      console.log(`🎯 Lead complete: ${session.leadData.name}`);
      saveLead(session.leadData).catch(console.error);
      appendToSheet(session.leadData).catch(console.error);
      sendNewLeadEmail(session.leadData).catch(console.error);
    }

    await saveSession(session);

    res.json({ reply, sessionId, leadData: session.leadData });

  } catch (err) {
    console.error('❌ /api/chat error:', err.message);
    res.json({ reply: 'Something went wrong. Please try again.' });
  }
});

// Backwards compatibility
app.post('/chat', (req, res) => {
  req.url = '/api/chat';
  app._router.handle(req, res);
});

// ─────────────────────────────────────────────
// CRM ENDPOINT
// ─────────────────────────────────────────────
app.get('/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  try {
    const leads = await leadsCol.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(leads);
  } catch (err) { res.json([]); }
});

// ─────────────────────────────────────────────
// HEALTH + DEBUG
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) + 's', ts: new Date().toISOString() });
});

app.get('/debug-email', async (req, res) => {
  try {
    await sendEmail({ subject: '✅ Comply website bot — email test', html: '<p>It works! 🎉</p>' });
    res.json({ success: true, sentTo: NOTIFY_EMAIL });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔥 Comply Website Bot — port ${PORT}`);
    console.log(`💬 Chat:   POST /api/chat`);
    console.log(`📊 Leads:  GET  /leads`);
    console.log(`❤️  Health: GET  /health\n`);
    startKeepAlive();
  });
});
