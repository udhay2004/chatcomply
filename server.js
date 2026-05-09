const express = require('express');
const path    = require('path');
const fetch   = require('node-fetch');
const { MongoClient } = require('mongodb');
const { google }      = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow the widget to be embedded on the WordPress site
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY  = (process.env.ANTHROPIC_API_KEY  || '').trim();
const MONGODB_URI        = (process.env.MONGODB_URI        || '').trim();
const GOOGLE_SHEET_ID    = (process.env.GOOGLE_SHEET_ID    || '').trim();
const GOOGLE_CREDENTIALS = (process.env.GOOGLE_CREDENTIALS || '').trim();
const RESEND_API_KEY     = (process.env.RESEND_API_KEY     || '').trim();
const NOTIFY_EMAIL       = (process.env.NOTIFY_EMAIL       || 'udhaymarwah96@gmail.com').trim();
const FROM_EMAIL         = (process.env.FROM_EMAIL         || 'Comply Bot <onboarding@resend.dev>').trim();
const KEEP_ALIVE_URL     = (process.env.KEEP_ALIVE_URL     || '').trim(); // your own Render URL

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
// KEEP-ALIVE (pings itself every 14 min so Render free tier stays awake)
// ─────────────────────────────────────────────
function startKeepAlive() {
  const url = KEEP_ALIVE_URL || `http://localhost:${process.env.PORT || 5000}/health`;
  setInterval(async () => {
    try {
      await fetch(url);
      console.log('💓 Keep-alive ping sent');
    } catch (e) {
      console.warn('⚠️ Keep-alive ping failed:', e.message);
    }
  }, 14 * 60 * 1000); // every 14 minutes
}

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
let sessionsCol;
let leadsCol;

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️ No MONGODB_URI — running without DB'); return; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db    = client.db('comply_globally');
    sessionsCol = db.collection('web_sessions');
    leadsCol    = db.collection('leads'); // SHARED with WhatsApp bot — same collection!
    await sessionsCol.createIndex({ sessionId: 1 }, { unique: true });
    await sessionsCol.createIndex({ lastActive: 1 }, { expireAfterSeconds: 86400 }); // sessions expire after 24h
    console.log('✅ MongoDB connected — using shared "leads" collection');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
  }
}

// Session identified by browser-generated sessionId (not phone number)
async function getSession(sessionId) {
  if (!sessionsCol) return freshSession(sessionId);
  let session = await sessionsCol.findOne({ sessionId });
  if (!session) {
    session = freshSession(sessionId);
    await sessionsCol.insertOne(session);
  }
  return session;
}

async function saveSession(session) {
  if (!sessionsCol) return;
  session.lastActive = new Date();
  await sessionsCol.replaceOne({ sessionId: session.sessionId }, session, { upsert: true });
}

async function saveLead(leadData) {
  if (!leadsCol) return;
  // source: 'website' so CRM can filter by source
  await leadsCol.insertOne({ ...leadData, source: 'website', createdAt: new Date() });
}

function freshSession(sessionId) {
  return {
    sessionId,
    history: [],
    leadData: {
      name: null,
      email: null,
      phone: null,
      currentCountry: null,
      targetCountry: null,
      serviceNeeded: null,
      businessStage: null,
      timeline: null,
    },
    leadSaved: false,
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────────
async function appendToSheet(leadData) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CREDENTIALS) return;
  try {
    const creds  = JSON.parse(GOOGLE_CREDENTIALS);
    const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Check if header exists
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1:A1' });
    if (!existing.data.values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
        requestBody: { values: [['Timestamp','Source','Name','Email','Phone','Current Country','Target Country','Service','Business Stage','Timeline']] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
      requestBody: { values: [[
        now,
        'Website',
        leadData.name           || '',
        leadData.email          || '',
        leadData.phone          || '',
        leadData.currentCountry || '',
        leadData.targetCountry  || '',
        leadData.serviceNeeded  || '',
        leadData.businessStage  || '',
        leadData.timeline       || '',
      ]] },
    });
    console.log('✅ Lead written to Google Sheet');
  } catch (err) {
    console.error('❌ Sheets error:', err.message);
  }
}

// ─────────────────────────────────────────────
// EMAIL (Resend)
// ─────────────────────────────────────────────
async function sendEmail({ subject, html }) {
  if (!RESEND_API_KEY) return;
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
          <div style="background:#1a1a2e;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">🌍 New Lead from Website — Comply Globally</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #eee;border-radius:0 0 8px 8px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;color:#666;width:140px">Name</td><td style="padding:8px"><b>${leadData.name || '—'}</b></td></tr>
              <tr style="background:#fff"><td style="padding:8px;color:#666">Email</td><td style="padding:8px">${leadData.email || '—'}</td></tr>
              <tr><td style="padding:8px;color:#666">Phone</td><td style="padding:8px">${leadData.phone || '—'}</td></tr>
              <tr style="background:#fff"><td style="padding:8px;color:#666">Based In</td><td style="padding:8px">${leadData.currentCountry || '—'}</td></tr>
              <tr><td style="padding:8px;color:#666">Target Country</td><td style="padding:8px">${leadData.targetCountry || '—'}</td></tr>
              <tr style="background:#fff"><td style="padding:8px;color:#666">Service</td><td style="padding:8px">${leadData.serviceNeeded || '—'}</td></tr>
              <tr><td style="padding:8px;color:#666">Business Stage</td><td style="padding:8px">${leadData.businessStage || '—'}</td></tr>
              <tr style="background:#fff"><td style="padding:8px;color:#666">Timeline</td><td style="padding:8px">${leadData.timeline || '—'}</td></tr>
            </table>
            <p style="margin-top:16px;color:#555;font-size:13px">This lead has been saved to MongoDB and your Google Sheet.</p>
          </div>
        </div>
      `
    });
    console.log('📧 New lead email sent');
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT (website version — no WhatsApp constraints)
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Comply, a smart and professional Global Expansion Assistant for Connect Ventures Inc. (brand name: Comply Globally). You help entrepreneurs, startups, freelancers, and businesses understand international expansion options via a website chat widget.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT COMPLY GLOBALLY
━━━━━━━━━━━━━━━━━━━━━━━━━━
Headquarters: Delaware, USA | Slogan: "Comply Globally"

CORE SERVICES:
1. Company Formation – Incorporation & registration in international jurisdictions
2. Banking Setup – Corporate bank accounts and cross-border finance solutions
3. Tax Compliance – IRS/GST/VAT filings, corporate tax, transfer pricing
4. Annual Maintenance – Registered Agent services, secretarial filings, compliance renewals
5. FEMA & Investment Advisory – For Indian businesses expanding overseas (RBI/FEMA regulations)
6. Residency & Golden Visas – Investment-linked residency programs (NOT travel visas)

COUNTRIES SERVED:
Americas: USA (Delaware), Canada
Middle East & Africa: UAE (Dubai/Abu Dhabi), Saudi Arabia, Egypt, Nigeria, Mauritius
Europe: UK, Netherlands, and all 27 EU member countries
Asia-Pacific: India, Singapore, Hong Kong, Indonesia, Thailand, Malaysia, Philippines

━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR GOAL
━━━━━━━━━━━━━━━━━━━━━━━━━━
Have a helpful, warm conversation. Naturally collect these details:
✅ Full Name | ✅ Email address | ✅ Phone number | ✅ Current country | ✅ Target country | ✅ Service needed | ✅ Business stage | ✅ Timeline

Once you have Name + Email + Current Country + Target Country, wrap up warmly:
"Thank you [Name]! Our expert will review your requirements and reach out to you at [email] within 24 hours. You can also reach us directly at +1 (302) 803-5851 or hello@complyglobally.com 🎉"

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Keep responses concise and clear (3-5 lines). This is a website chat, not a phone call.
- Be warm, professional, and helpful — like a smart consultant, not a form.
- When someone first opens chat, greet them and ask what country they are currently based in.
- Collect info naturally through conversation — never ask for everything at once.
- Use emojis sparingly (✅ 🌍 💼 📋)
- If they ask for contact details: Email: hello@complyglobally.com | Phone: +1 (302) 803-5851
- If they want to speak to someone: give them the contact details above and say the team will reach out within 24 hours.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ No specific legal/tax advice → "Our experts will guide you during consultation"
❌ No prices → "Pricing depends on jurisdiction — our team will send a custom quote"
❌ No guarantees on bank/visa approval
❌ No off-topic responses → redirect to global business expansion`;

// ─────────────────────────────────────────────
// LEAD EXTRACTION (same logic, adapted for website — adds email/phone)
// ─────────────────────────────────────────────
function extractLeadData(session, userMessage) {
  const lead = session.leadData;
  const msg  = userMessage.toLowerCase().trim();

  // Name
  if (!lead.name) {
    const namePatterns = [
      /(?:my name is|name is|i'm|i am|this is|call me)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})/i,
      /^([a-zA-Z]+(?:\s+[a-zA-Z]+){1,2})\s*(?:here|,|$)/i,
    ];
    const skipWords = new Set(['based','from','india','uae','uk','usa','hi','hello','hey','yes','no','sir','madam','canada','singapore','vietnam','dubai','indonesia','there','glad','happy','great','good','fine','well','not','just','and','the','for','with','want','expand','going','looking','please','thanks']);
    for (const pat of namePatterns) {
      const m = userMessage.match(pat);
      if (m) {
        const words = m[1].trim().split(/\s+/);
        while (words.length > 0 && skipWords.has(words[words.length-1].toLowerCase())) words.pop();
        const name = words.join(' ').trim();
        if (name.length > 1 && !skipWords.has(name.toLowerCase())) {
          lead.name = name.replace(/\b\w/g, c => c.toUpperCase());
          break;
        }
      }
    }
  }

  // Email
  if (!lead.email) {
    const emailMatch = userMessage.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) lead.email = emailMatch[0];
  }

  // Phone
  if (!lead.phone) {
    const phoneMatch = userMessage.match(/(?:\+?\d[\d\s\-]{8,14}\d)/);
    if (phoneMatch) {
      const cleaned = phoneMatch[0].replace(/[\s\-]/g, '');
      if (cleaned.length >= 10) lead.phone = cleaned;
    }
  }

  // Countries
  const countries = ['vietnam','india','uae','dubai','abu dhabi','usa','united states','america','uk','united kingdom','britain','england','singapore','hong kong','canada','netherlands','holland','saudi arabia','saudi','mauritius','egypt','nigeria','indonesia','thailand','malaysia','philippines','germany','france','italy','spain','portugal','ireland'];
  const countryMap = {'dubai':'UAE','abu dhabi':'UAE','america':'USA','united states':'USA','britain':'UK','england':'UK','united kingdom':'UK','holland':'Netherlands','saudi':'Saudi Arabia'};

  const expansionKw = ['expand to','expanding to','open in','setup in','set up in','register in','incorporate in','start in','move to','moving to','want to go','want in','looking to expand','planning to'];
  const currentKw   = ['based in','currently based','i am in',"i'm in",'living in','located in','from','we are from','our office is'];

  const isExpansion = expansionKw.some(k => msg.includes(k));
  const isCurrent   = currentKw.some(k => msg.includes(k));

  for (const c of countries) {
    if (!msg.includes(c)) continue;
    const mapped = countryMap[c] || c.replace(/\b\w/g, x => x.toUpperCase());
    if (isExpansion && !lead.targetCountry) { lead.targetCountry  = mapped; break; }
    else if (isCurrent && !lead.currentCountry) { lead.currentCountry = mapped; break; }
    else if (!lead.currentCountry) { lead.currentCountry = mapped; break; }
    else if (!lead.targetCountry)  { lead.targetCountry  = mapped; break; }
  }

  // Service
  if (!lead.serviceNeeded) {
    if (msg.match(/compan|incorporat|formation|register|llc|llp|pvt|entity|business setup/)) lead.serviceNeeded = 'Company Formation';
    else if (msg.match(/bank|account|finance|payment/))                                        lead.serviceNeeded = 'Banking Setup';
    else if (msg.match(/tax|vat|gst|irs|filing/))                                             lead.serviceNeeded = 'Tax Compliance';
    else if (msg.match(/fema|rbi|overseas invest/))                                            lead.serviceNeeded = 'FEMA & Investment';
    else if (msg.match(/visa|residency|golden visa/))                                          lead.serviceNeeded = 'Residency / Golden Visa';
    else if (msg.match(/annual|maintenance|secretar|compliance/))                             lead.serviceNeeded = 'Annual Maintenance';
  }

  // Business stage
  if (!lead.businessStage) {
    if (msg.match(/startup|start.?up|just start|new business|early stage/)) lead.businessStage = 'Startup';
    else if (msg.match(/freelanc|independ|consultant|solo/))                 lead.businessStage = 'Freelancer';
    else if (msg.match(/sme|small.?medium|small business/))                  lead.businessStage = 'SME';
    else if (msg.match(/established|enterprise|corporat|large|mnc/))         lead.businessStage = 'Established Company';
  }

  // Timeline
  if (!lead.timeline) {
    const tm = msg.match(/(\d+)\s*(?:month|week|year)/);
    if (tm) {
      const n = parseInt(tm[1]);
      if (msg.includes('week'))  lead.timeline = n <= 2 ? 'Immediately' : 'Within 1 month';
      else if (n <= 1)           lead.timeline = 'Within 1 month';
      else if (n <= 3)           lead.timeline = '1-3 months';
      else if (n <= 6)           lead.timeline = '3-6 months';
      else                       lead.timeline = '6+ months';
    } else if (msg.match(/asap|urgent|immediately|right now|today/)) {
      lead.timeline = 'Immediately';
    } else if (msg.match(/this month|soon|shortly/)) {
      lead.timeline = 'Within 1 month';
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

  // Build context from what we know
  const known = [];
  const l = session.leadData;
  if (l.name)           known.push(`Name: ${l.name}`);
  if (l.email)          known.push(`Email: ${l.email}`);
  if (l.phone)          known.push(`Phone: ${l.phone}`);
  if (l.currentCountry) known.push(`Based in: ${l.currentCountry}`);
  if (l.targetCountry)  known.push(`Target: ${l.targetCountry}`);
  if (l.serviceNeeded)  known.push(`Service: ${l.serviceNeeded}`);
  if (l.businessStage)  known.push(`Stage: ${l.businessStage}`);
  if (l.timeline)       known.push(`Timeline: ${l.timeline}`);

  const contextNote = known.length
    ? `\n\n[CUSTOMER CONTEXT — do not re-ask these: ${known.join(' | ')}]`
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
        system: SYSTEM_PROMPT + contextNote,
        messages: session.history,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || "I'm looking into that — could you give me a moment? 🙏";

    session.history.push({ role: 'assistant', content: reply });
    return reply;

  } catch (err) {
    console.error('❌ Claude error:', err.message);
    return "I'm having a small technical issue. Please try again in a moment, or reach us directly at hello@complyglobally.com 🙏";
  }
}

// ─────────────────────────────────────────────
// MAIN CHAT ENDPOINT
// ─────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || !sessionId) return res.json({ reply: 'Missing message or sessionId.' });

    const session = await getSession(sessionId);

    extractLeadData(session, message);

    const reply = await getClaudeReply(session, message);

    // Save lead once core info is complete
    if (!session.leadSaved && isCoreLeadComplete(session.leadData)) {
      session.leadSaved = true;
      console.log(`🎯 Lead complete for session ${sessionId}`);
      try { await saveLead(session.leadData); } catch (e) { console.error('DB error:', e.message); }
      try { await appendToSheet(session.leadData); } catch (e) { console.error('Sheet error:', e.message); }
      try { await sendNewLeadEmail(session.leadData); } catch (e) { console.error('Email error:', e.message); }
    }

    await saveSession(session);
    res.json({ reply, leadData: session.leadData });

  } catch (err) {
    console.error('❌ /chat error:', err.message);
    res.json({ reply: 'Something went wrong. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// CRM ENDPOINT — returns ALL leads (website + WhatsApp + landing page)
// ─────────────────────────────────────────────
app.get('/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  try {
    const leads = await leadsCol.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(leads);
  } catch (err) {
    res.json([]);
  }
});

// ─────────────────────────────────────────────
// HEALTH + DEBUG
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) + 's', time: new Date().toISOString() });
});

app.get('/debug-email', async (req, res) => {
  try {
    await sendEmail({ subject: '✅ Test email — Comply Website Bot', html: '<p>Email is working! 🎉</p>' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
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
    console.log(`\n🔥 Comply Website Bot running on port ${PORT}`);
    console.log(`💬 Chat:    POST /chat`);
    console.log(`📊 Leads:   GET  /leads`);
    console.log(`❤️  Health:  GET  /health\n`);
    startKeepAlive();
  });
});
