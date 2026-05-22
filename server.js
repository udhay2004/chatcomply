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
// KEEP-ALIVE
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
let knowledgeCol;  // NEW: for adaptive learning

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️ No MONGODB_URI — running without DB'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db    = client.db('comply_globally');
    sessionsCol  = db.collection('web_sessions');
    leadsCol     = db.collection('leads');
    knowledgeCol = db.collection('knowledge_insights'); // NEW

    await sessionsCol.createIndex({ sessionId: 1 }, { unique: true });
    await sessionsCol.createIndex({ lastActive: 1 }, { expireAfterSeconds: 86400 });
    await leadsCol.createIndex({ email: 1 });
    await leadsCol.createIndex({ phone: 1 });
    await knowledgeCol.createIndex({ topic: 1 }); // NEW
    console.log('✅ MongoDB connected — db: comply_globally');
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
      companyName:         null,   // NEW
      currentCountry:      null,
      targetCountry:       null,
      additionalCountries: [],     // NEW — multi-country support
      serviceNeeded:       null,
      businessStage:       null,
      timeline:            null,
      documentsRequired:   null,
      topQuestions:        [],     // NEW — stores the 3 questions
      questionAnswers:     [],     // NEW — stores answers to those 3 questions
      conversationSummary: null,   // NEW — AI-generated summary
    },
    leadSaved:           false,
    humanRequested:      false,
    questionsAsked:      false,    // NEW — track if we've asked for 3 questions
    questionsAnswered:   false,    // NEW — track if they've answered
    messageCount:        0,        // NEW — for timing the 3-question prompt
    createdAt:           new Date(),
    lastActive:          new Date(),
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
// ADAPTIVE LEARNING — stores common questions/topics
// So future conversations benefit from patterns seen across all users
// ─────────────────────────────────────────────
async function storeInsight(topic, question, answer, country) {
  if (!knowledgeCol) return;
  try {
    await knowledgeCol.updateOne(
      { topic, question },
      {
        $inc: { frequency: 1 },
        $set: { lastSeen: new Date(), country: country || null },
        $setOnInsert: { topic, question, answer, createdAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('❌ Insight store error:', err.message);
  }
}

async function getTopInsights(country, limit = 5) {
  if (!knowledgeCol) return [];
  try {
    const query = country ? { country } : {};
    return await knowledgeCol
      .find(query)
      .sort({ frequency: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    return [];
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
        requestBody: { values: [['Timestamp','Source','Name','Email','Phone','Company','Current Country','Target Country','Additional Countries','Service','Stage','Timeline','Top Questions','Q Answers','Summary','Documents Required']] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
      requestBody: { values: [[
        now, 'Website',
        leadData.name              || '',
        leadData.email             || '',
        leadData.phone             || '',
        leadData.companyName       || '',
        leadData.currentCountry    || '',
        leadData.targetCountry     || '',
        (leadData.additionalCountries || []).join(', '),
        leadData.serviceNeeded     || '',
        leadData.businessStage     || '',
        leadData.timeline          || '',
        (leadData.topQuestions     || []).join(' | '),
        (leadData.questionAnswers  || []).join(' | '),
        leadData.conversationSummary || '',
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
                ['Name',                leadData.name],
                ['Email',               leadData.email],
                ['Phone',               leadData.phone],
                ['Company',             leadData.companyName],
                ['Based In',            leadData.currentCountry],
                ['Target Country',      leadData.targetCountry],
                ['Additional Countries',(leadData.additionalCountries||[]).join(', ')],
                ['Service',             leadData.serviceNeeded],
                ['Stage',               leadData.businessStage],
                ['Timeline',            leadData.timeline],
                ['Top Question 1',      (leadData.topQuestions||[])[0]],
                ['Answer 1',            (leadData.questionAnswers||[])[0]],
                ['Top Question 2',      (leadData.topQuestions||[])[1]],
                ['Answer 2',            (leadData.questionAnswers||[])[1]],
                ['Top Question 3',      (leadData.topQuestions||[])[2]],
                ['Answer 3',            (leadData.questionAnswers||[])[2]],
                ['Conversation Summary',leadData.conversationSummary],
                ['Documents Required',  leadData.documentsRequired],
              ].map(([k,v], i) => `
                <tr style="background:${i%2===0?'#fff':'#f5f5f5'}">
                  <td style="padding:9px 12px;color:#666;width:160px"><b>${k}</b></td>
                  <td style="padding:9px 12px">${v || '—'}</td>
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
// KNOWLEDGE BASE — embedded from your PDFs and Canada guide
// This is baked into the system prompt so Claude knows it deeply
// ─────────────────────────────────────────────
const KNOWLEDGE_BASE = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — USA INCORPORATION (State Navigator)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FRANCHISE TAX COMPARISON (per year):
• Delaware Corp: $400 minimum (can reach $50,000–$200,000+ via Authorized Shares Method — use Assumed Par Value method to reduce)
• Delaware LLC: $300/year flat regardless of revenue
• Wyoming LLC: $62/year flat — most cost-effective
• Nevada LLC: $200/year + mandatory state business license
• Florida LLC: $138.75 annual report (no franchise tax for LLCs)
• Texas: 0% under $2.47M gross receipts (margin-based franchise tax)
• New Mexico LLC: $0 annual report, no franchise tax — absolute cheapest
• South Dakota: $50/year flat

INCORPORATION FILING FEES:
• Delaware: $90 LLC / $89 Corp
• Wyoming: $100 LLC / $100 Corp
• Nevada: $75 + $200 license (LLC) / $75 + $500 license (Corp)
• Florida: $125 LLC / $70 Corp
• Texas: $300 LLC / $300 Corp (highest)
• New Mexico: $50 LLC / $100 Corp (cheapest)
• South Dakota: $150 LLC / $150 Corp

STATE SCORECARD (out of 5, higher = better for foreign founders):
Criterion         | DE | WY | NV | FL | TX | NM | SD
Tax Burden        | 2  | 5  | 4  | 4  | 3  | 5  | 5
Formation Cost    | 4  | 4  | 3  | 4  | 2  | 5  | 3
Compliance Ease   | 2  | 5  | 3  | 3  | 3  | 5  | 4
Foreign Founder   | 3  | 5  | 4  | 4  | 3  | 4  | 4
Privacy           | 2  | 5  | 4  | 3  | 2  | 3  | 3
Logistics/Ports   | 1  | 1  | 2  | 5  | 5  | 2  | 1
HR Availability   | 3  | 1  | 3  | 4  | 5  | 2  | 1
Market Perception | 5  | 3  | 3  | 4  | 4  | 2  | 2
TOTAL (/40)       | 22 | 29 | 26 | 31 | 27 | 28 | 23

RECOMMENDATIONS BY BUSINESS TYPE:
• Raising institutional VC → Delaware C-Corp (non-negotiable)
• Remote e-commerce, no US presence → Wyoming LLC
• Shipping through Gulf/Caribbean ports → Florida LLC
• High-volume logistics, Houston area → Texas LLC
• Pure cost minimization, digital business → New Mexico LLC
• Asset protection + privacy priority → Wyoming LLC
• Financial services, banking focus → South Dakota LLC/Corp
• Entertainment, gaming → Nevada LLC/Corp
• Building US team (Austin/Dallas) → Texas LLC or C-Corp
• Latin American trade, Miami hub → Florida LLC

WYOMING KEY FACTS (top choice for most foreign founders):
• Invented the modern LLC in 1977
• No state income tax (personal or corporate)
• $62/year flat annual report fee
• Member names NOT required in public filings (strong privacy)
• 100% foreign ownership allowed, no US partner required
• No operating agreement requirements (flexible)
• Strongest charging order protection in the US
• Fintech banks (Mercury, Relay) fully accept Wyoming LLCs

FLORIDA KEY FACTS:
• No personal income tax
• World-class seaports: Port of Miami (#1 cruise port), Port Everglades, Port Tampa Bay, JAXPORT
• Best for Latin American, Caribbean, and European trade routes
• Corporate income tax 5.5% (only applies with physical Florida nexus)
• No franchise tax for LLCs; $138.75 annual report
• Growing tech ecosystem in Miami ('Silicon Beach')

DELAWARE KEY FACTS:
• Over 60% of Fortune 500 incorporated here
• Court of Chancery — most developed corporate case law since 1792
• Use ONLY if raising institutional VC
• Delaware Franchise Tax Trap: authorizing millions of shares → $50K–$200K+ bill (use Assumed Par Value method)
• LLC members semi-public

CALIFORNIA WARNING:
• If you hire employees, store inventory, or have any physical presence in California, you must register as foreign entity
• $800/year minimum franchise tax PLUS California income tax
• This applies regardless of your incorporation state — many founders face back taxes

BANKING ACCESS FOR FOREIGN FOUNDERS (no SSN required):
• Mercury (Fintech): No SSN, no in-person, EIN only, $0/month — BEST OVERALL
• Relay (Fintech): No SSN, multiple sub-accounts, $0–$30/month
• Brex (Fintech): No SSN, great for spend management
• Wise Business: No SSN, best for FX transfers
• Chase Business: SSN preferred, often requires in-person
• Bank of America: SSN required, in-person — not feasible remotely

EIN (Federal Tax ID) FOR FOREIGN NATIONALS:
• Method 1 (Fastest): Call IRS International +1 (267) 941-1099, Mon–Fri 6am–11pm ET — get EIN same day
• Method 2 (4–6 weeks): Complete IRS Form SS-4, fax to +1 (304) 707-9471
• Method 3: Via registered agent or formation service ($50–$150)

FINCEN BOI REPORTING (2024 — mandatory):
• All US entities must file Beneficial Ownership Information with FinCEN
• Companies formed Jan 1, 2024 onward: file within 90 days of formation
• Companies formed before Jan 1, 2024: deadline was Jan 1, 2025
• Filing is FREE at boiefiling.fincen.gov
• Penalties: $591/day (inflation-adjusted) + potential criminal liability
• Foreign owners must provide passport information

TAX TREATIES & WITHHOLDING RATES (dividends from US C-Corps):
• UK: 15% general / 5% substantial holdings (very favorable)
• Germany: 15% / 5%
• India: 25% / 15%
• Canada: 15% / 5%
• Australia: 15% / 5%
• UAE: NO US-UAE tax treaty — 30% full withholding
• Brazil: No treaty — 30%
• Singapore: No comprehensive treaty — 30%
• Nigeria: No treaty — 30%

ENTITY TYPES FOR FOREIGN FOUNDERS:
• Single-Member LLC (SMLLC): TOP RECOMMENDATION. Disregarded entity, no US corporate tax, 100% foreign ownership, full liability protection, lowest compliance. BUT must file Form 5472 annually ($25,000 penalty if missed).
• Multi-Member LLC (MMLLC): For 2+ founders. Files Form 1065 (partnership return). Flexible profit allocation.
• C-Corporation: Only for institutional VC fundraising. Double taxation (21% corporate + dividend withholding). Can issue preferred shares, stock options. QSBS exclusion: up to $10M capital gains excluded if held 5+ years.
• S-Corporation: NOT AVAILABLE to foreign founders — requires all shareholders to be US citizens or permanent residents.
• Sole Proprietorship: NEVER use — zero liability protection.
• Series LLC: Available in Wyoming, Delaware, Nevada, Texas. Multiple liability-separated series under one umbrella. Good for multiple e-commerce brands or real estate.

FORM 5472 — MOST DANGEROUS COMPLIANCE TRAP:
• Foreign-owned SMLLC must file Form 5472 + pro forma Form 1120 annually
• Due April 15 (or September 15 with extension)
• Reports all transactions between owner and LLC (capital contributions, distributions, loans)
• Penalty: $25,000 per form per year — enforced actively since 2017

EFFECTIVELY CONNECTED INCOME (ECI) VS FDAP:
• ECI (active business income): taxed at graduated US rates 10–37%
• FDAP (dividends, interest, royalties): 30% flat withholding (reducible by treaty)
• Capital gains (non-real estate): Generally 0% for non-residents
• FIRPTA (real estate): 15% withholding on gross sales price

POST-INCORPORATION CHECKLIST:
• Obtain EIN (IRS phone +1-267-941-1099)
• File FinCEN BOI report within 90 days
• Open Mercury or Relay business bank account
• Draft Operating Agreement (LLC) or Bylaws (Corp)
• Set up bookkeeping: QuickBooks, Xero, or Wave
• Register for state sales tax where economic nexus exists
• Engage US CPA for annual filings (Form 5472 / 1120 / 1065)
• Apply for ITIN to claim tax treaty benefits

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — CANADA (Entry Canada Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT:
• Population: 41,472,081 (Jan 1, 2026)
• IMF 2026 GDP: ~US$2.51 trillion
• IMF 2026 real GDP growth projection: 1.5%
• IMF 2026 inflation projection: 2.5%
• South Asian population: ~2.6 million (India = 44% of South Asians)
• Major business hubs: Toronto (financial centre), Vancouver, Montreal, Calgary, Ottawa, Edmonton, Waterloo
• Trade agreements: CUSMA, CETA, CPTPP — plus WTO, OECD, G7, G20 member
• Canada–India tax treaty: in force (relevant for Indian businesses)

WHY CANADA FOR INDIAN BUSINESSES:
• Large, stable, high-income English-language market
• Common-law tradition (familiar to Indian businesses) in most provinces (Quebec uses civil law)
• Significant South Asian community — cultural familiarity
• Deep capital markets and established talent pools
• 100% foreign ownership generally permitted
• No exchange controls for ordinary commercial remittances

ENTRY TIMELINE:
• Simple incorporation: can be done online
• Full operational readiness (banking, tax registrations, payroll, licensing): typically 2–8 weeks
• Government filing fees: modest
• Larger costs: professional fees, registered office, banking/KYC support, ongoing compliance

BUSINESS STRUCTURES:
• Corporation (most common for foreign investors): separate legal entity, limited liability, easiest for banks and investors
• Branch/Extra-Provincial Registration: Indian parent fully liable, no separate legal entity
• Partnership / Limited Partnership: less common, specific use cases
• LLP: available for certain professions

RESIDENT DIRECTOR REQUIREMENT (Federal):
• At least 25% of directors must be resident Canadians
• If fewer than 4 directors, at least 1 must be a resident Canadian
• This is a key planning point for Indian businesses — nominee directors or local partners may be needed

INCORPORATION OPTIONS:
• Federal incorporation (Canada Business Corporations Act): available across all of Canada
• Provincial incorporation: preferred if business is concentrated in one province (e.g., Ontario Business Corporations Act for Ontario)

TAXATION:
• Federal corporate tax rate: 15% (standard)
• Small business deduction: reduces rate to 9% on qualifying active business income (up to business limit) — for Canadian-Controlled Private Corporations (CCPCs)
• Combined federal + provincial rates vary by province
• GST/HST registration required once taxable revenues exceed CAD 30,000 over 4 consecutive calendar quarters
• GST/HST reporting: monthly, quarterly, or annual depending on account
• Withholding tax on cross-border payments: dividends, interest, royalties, fees for services — treaty relief available
• Canada–India tax treaty reduces withholding on qualifying payments
• Transfer pricing rules apply to intercompany transactions
• SR&ED (Scientific Research & Experimental Development): major federal tax incentive for R&D-intensive businesses
• Clean Technology Investment Tax Credit: available for qualifying investments
• NRC IRAP: Innovation funding program

BANKING IN CANADA:
• Major banks: RBC, TD, Scotiabank, BMO, CIBC, National Bank
• Required for account opening: Certificate/Articles of Incorporation, Business Number (BN), corporate registers, director and beneficial owner ID, proof of address, expected business activity and source of funds
• Fintech options may be available depending on client profile

BUSINESS NUMBER (BN) AND TAX REGISTRATIONS:
• Business Number: federal identifier issued by CRA — required for all tax program accounts
• GST/HST account
• Payroll deductions account (if hiring)
• Corporate income tax account
• Import/export account (if applicable)
• All obtainable electronically through CRA

PAYROLL AND EMPLOYMENT:
• Federal employment governed by Canada Labour Code (federally regulated industries)
• Most workplaces: provincial/territorial employment standards
• Payroll obligations: source deductions, CPP (Canada Pension Plan), EI (Employment Insurance), income tax
• T4 information returns required annually
• CPP and EI rates change annually — review each year
• Minimum wages, termination, vacation, overtime vary by province

IMMIGRATION FOR INDIAN BUSINESSES:
• Business visitors: no work permit required for meetings/events
• Work permits: required for operational roles
• International Mobility Program (IMP)
• Labour Market Impact Assessment (LMIA) routes
• Global Skills Strategy: faster processing for certain roles
• Start-Up Visa Program: PAUSED for new commitment certificates as of January 1, 2026 — check latest IRCC guidance before relying on this route

INTELLECTUAL PROPERTY:
• Canadian Intellectual Property Office (CIPO): handles patents, trademarks, industrial designs
• Clear brand names before launch
• Consider trademark applications at federal level
• File patents before public disclosure

PRIVACY & DATA:
• PIPEDA (Personal Information Protection and Electronic Documents Act) — federal private sector privacy law
• Some provinces have substantially similar laws
• Requires: lawful purpose, transparent collection notices, appropriate safeguards, breach management
• Breach notification required if real risk of significant harm

REPATRIATION FROM CANADA TO INDIA:
• Repatriation generally possible through: dividends, intercompany services, interest, royalties, management fees, share redemptions
• No exchange-control approvals required for ordinary commercial remittances
• Must align with: treaty analysis, withholding tax, commercial substance, transfer pricing
• For Indian groups: ODI/FEMA analysis and treaty planning should be completed before funds move

INVESTMENT CANADA ACT (ICA):
• National security review can apply to investments of any size in sensitive sectors
• Some industries subject to sector-specific federal or provincial restrictions
• Net benefit review applies for larger direct investments
• Foreign investors can generally own 100% of a Canadian corporation

ONGOING COMPLIANCE OBLIGATIONS:
• Federal corporations: file annual return + ISC information within 60 days of corporation's anniversary date
• Individuals with Significant Control (ISC): must be recorded and filed
• Provincial extra-registration: required if operating in provinces where not incorporated
• CRA filings: T2 corporate income tax return, GST/HST returns, payroll remittances, T4s

COMPLIANCE PENALTIES (Canada):
• Late filing of corporate annual return: penalties apply (check Corporations Canada)
• GST/HST non-filing: interest and penalties from CRA
• Payroll remittance failures: significant penalties and interest
• Transfer pricing violations: major penalties
• Privacy breaches (PIPEDA): reputational and regulatory risk; notification required where real risk of significant harm
• ICA non-compliance: can result in forced divestiture or sanctions

DISPUTE RESOLUTION:
• Mature court system + active arbitration and mediation culture
• New York Convention supports international arbitration enforcement
• Commercial agreements: include escalation, mediation, and arbitration clauses

EXIT OPTIONS:
• Share sale, asset sale, amalgamation, wind-up, dissolution, cross-border restructuring
• Most tax-efficient path depends on Canadian tax residence, asset mix, retained earnings, treaty position

COMPLY GLOBALLY CANADA SERVICES:
• Pre-entry advisory and entity structure planning
• Canadian incorporation and extra-provincial registration support
• BN, GST/HST, payroll, and corporate tax account setup
• Banking and KYC support
• Immigration and work-authorization coordination
• Ongoing compliance calendars, annual filings, and governance support
• Fixed-fee incorporation packages, monthly retainers, project-based support, full entry packages

KEY CANADIAN LEGAL/REGULATORY BODIES:
• Corporations Canada: incorporation and corporate filings
• Canada Revenue Agency (CRA): tax and payroll
• Office of the Privacy Commissioner (OPC): privacy oversight
• CIPO: trademarks and patents
• OSFI: financial institutions
• FINTRAC: anti-money laundering
• Health Canada: regulated health products
• Competition Bureau: competition and consumer protection

PRIORITY SECTORS IN CANADA:
• Clean technology, advanced manufacturing, artificial intelligence, life sciences, natural resources, digital services, industrial innovation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — UNITED KINGDOM (Entry UK Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT:
• GDP: ~USD 3.4 trillion (2025) — world's 6th largest economy
• Currency: Pound Sterling (GBP)
• GDP growth: 1–2%; Inflation: ~2–3%; Services = ~80% of GDP
• Indian diaspora: 1.8+ million people of Indian origin
• Key hubs: London (primary), Manchester, Birmingham, Edinburgh, Glasgow, Bristol, Leeds
• Legal system: Common law (England & Wales; Scotland: mixed civil/common law)
• India–UK Free Trade Agreement signed 24 July 2025 — implementation follows treaty process
• UK joined CPTPP December 2024
• 130+ Double Tax Treaties including India (since 1993 with subsequent protocols)

WHY UK FOR INDIAN BUSINESSES:
• World-leading financial centre (London)
• English-language business environment — familiar to Indian professionals
• Strong India-UK historical business linkages and large Indian diaspora
• Common-law tradition familiar to Indian businesses
• Gateway to European, Middle Eastern, and African markets
• No UK-resident director required, no local shareholders required
• No minimum share capital (can incorporate with just GBP 1)
• UK does NOT impose withholding tax on dividends paid by UK companies — major advantage

ENTRY TIMELINE & COSTS:
• Companies House registration: typically within 24 hours of online application
• Full operational setup (banking, HMRC, PAYE): 4–8 weeks
• Incorporation cost: GBP 50 (direct online filing) to GBP 3,000–8,000 (full-service)
• Bank account opening is often the lengthiest step (2–8 weeks)

BUSINESS STRUCTURES:
• Private Company Limited by Shares (Ltd): most common, no minimum capital, preferred by Indian businesses
• Public Limited Company (PLC): required for stock market listing, minimum GBP 50,000 share capital (25% paid-up)
• UK Establishment (formerly Overseas Branch): Indian parent fully liable for UK PE profits
• Limited Liability Partnership (LLP): useful for professional services firms
• No requirement for UK-resident directors or shareholders
• Must have at least one natural person director aged 16+

IDENTITY VERIFICATION (NEW — from 18 November 2025):
• Identity verification is now a legal requirement for directors and PSCs (Persons with Significant Control)
• 12-month transition period for existing appointees
• Verify via GOV.UK One Login

TAXATION:
• Corporation Tax: 19% (profits up to GBP 50,000) / 25% (profits over GBP 250,000) — rates unchanged for FY 2026-27
• Thresholds divided by number of associated companies plus one — important for Indian groups with multiple subsidiaries
• VAT: standard rate 20%, reduced rate 5%, zero rate for certain items
• VAT registration mandatory if taxable turnover exceeds GBP 90,000 in any rolling 12-month period (or expected in next 30 days)
• VAT returns: quarterly under Making Tax Digital (MTD), payment due 1 month and 7 days after period end
• Making Tax Digital for Income Tax starts 6 April 2026 for sole traders/landlords with qualifying income over £50,000
• PAYE: employer NI at 15% on earnings above GBP 5,000/year; employee NI at 8% above GBP 12,570
• National Living Wage (21+): GBP 12.71/hour from April 2026
• Auto-enrolment pension: mandatory for eligible workers — minimum 8% total (3% employer + 5% employee)
• Employment Allowance: up to GBP 10,500 reduces employer NI for eligible employers
• Annual Investment Allowance (AIA): 100% deduction on qualifying plant/machinery up to GBP 1 million/year
• Full Expensing: 100% first-year allowance on main rate plant/machinery (permanent for companies)
• Patent Box: 10% effective Corporation Tax rate on profits from qualifying patented inventions
• R&D Relief: merged scheme (from 1 April 2024) — 20% above-the-line credit (RDEC); enhanced support for loss-making R&D-intensive SMEs spending 30%+ on R&D
• Business Asset Disposal Relief: 18% rate on qualifying gains from 6 April 2026, GBP 1 million lifetime limit
• SEIS/EIS: tax incentives for UK individual investors in qualifying startups
• Investment Zones: 12 zones offering SDLT relief, enhanced capital allowances, Business Rates relief
• Freeports: 8 designated zones (Thames, Liverpool, Solent, Plymouth, Teesside, Humber, East Midlands, Freeport East)

WITHHOLDING TAX (UK):
• Dividends paid by UK companies: NO UK withholding tax — major advantage vs other jurisdictions
• Interest, royalties, other payments: typically 20%, reducible to 10–15% under India-UK DTAA
• Indian parent must comply with Indian FEMA reporting for inward remittances

INCORPORATION PROCESS (Companies House):
1. Verify name availability (Companies House WebCheck + IPO trademark register)
2. Decide entity type (Ltd most common)
3. Identify directors (min 1 natural person, 16+, no UK residency required)
4. Identify shareholders and PSCs (those owning 25%+ shares/voting rights)
5. Determine registered office (virtual office acceptable; PO Boxes no longer permitted under ECCTA 2023)
6. Prepare Memorandum and Articles of Association (model articles available from GOV.UK)
7. Complete identity verification via GOV.UK One Login
8. File online at Companies House — approval typically within 24 hours

BANKING IN THE UK:
• High-street banks: Barclays, HSBC, Lloyds, NatWest, Santander (2–8 weeks for account opening)
• Digital alternatives (faster — often days): Wise Business, Tide, Starling Bank, Monzo Business, Revolut Business, ANNA Money
• Required docs: Certificate of Incorporation, MOA/Articles, ID for all directors and PSCs, proof of registered office, business plan, projected turnover, source of funds

EMPLOYMENT & IMMIGRATION:
• Maximum 48-hour working week (employees may opt out)
• Minimum 28 days paid annual leave (can include 8 bank holidays)
• Skilled Worker Visa: requires UK employer Sponsor Licence, minimum salary thresholds, up to 5 years
• Senior or Specialist Worker Visa (Global Business Mobility): intra-company transfers, minimum GBP 48,500
• Innovator Founder Visa: innovative business idea, endorsed by approved body
• Global Talent Visa: leaders in academia, research, arts, digital technology
• Expansion Worker Visa: senior employees establishing UK presence for overseas business
• UK-India Young Professionals Scheme: ages 18–30, live and work in UK up to 2 years

KEY COMPLIANCE OBLIGATIONS:
• Confirmation Statement: due annually on anniversary of incorporation
• Annual Accounts: due 9 months after accounting reference date (21 months after first incorporation for first set)
• Corporation Tax: due 9 months and 1 day after accounting period end (small companies); large companies pay quarterly
• CT600 return: due 12 months after period end
• PAYE Real Time Information (RTI): report on or before each payday
• VAT returns: quarterly under MTD

UK DATA PROTECTION:
• UK GDPR (UK-specific, mirrors EU GDPR) + Data Protection Act 2018
• Maximum fines: greater of GBP 17.5 million or 4% of global annual turnover
• Breach notification to ICO within 72 hours
• ICO registration annual fee: GBP 40–2,900 based on size and turnover

KEY RISKS FOR INDIAN BUSINESSES IN UK:
• NSIA mandatory notification for acquisitions in 17 sensitive sectors (defense, AI, energy, communications, etc.)
• UK Bribery Act 2010: extraterritorial application
• UK Corporate Criminal Offence (Criminal Finances Act 2017): failure to prevent facilitation of tax evasion
• Pillar Two Multinational Top-up Tax for large groups (revenue >EUR 750m)
• Rapidly evolving Companies House transparency requirements under ECCTA 2023

COMPLY GLOBALLY UK SERVICES:
• Pre-entry advisory, FEMA ODI structuring, India-UK DTAA planning
• UK company incorporation, identity verification support, registered office
• UK tax registration (Corporation Tax, VAT, PAYE), R&D tax credits, transfer pricing
• UK banking introductions
• Sponsor Licence, Skilled Worker visas, intra-company transfer visas, Innovator Founder visas
• Ongoing compliance: Confirmation Statements, Annual Accounts, CT returns, VAT, PAYE/RTI
• Indian parent compliance: APR, FLA Return, Form AOC-1, Foreign Tax Credit claims

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — SINGAPORE (Entry Singapore Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT:
• Sovereign city-state and parliamentary republic
• Population: ~5.9 million
• Currency: Singapore Dollar (SGD)
• One of Asia's major financial, logistics, shipping, and aviation hubs
• Strengths: financial services, wholesale trade, precision engineering, electronics, chemicals, biomedical sciences, digital services, maritime, aviation
• Legal system: Common law
• Key agreements: ASEAN, RCEP, CPTPP, India-Singapore CECA, India-Singapore tax treaty

WHY SINGAPORE FOR INDIAN BUSINESSES:
• Highly open economy, 100% foreign ownership generally allowed
• Competitive 17% corporate income tax rate
• ONE-TIER dividend system — dividends are generally exempt from further tax in shareholders' hands
• No capital gains tax in most ordinary commercial cases
• No withholding tax on dividends (one-tier system)
• Strong IP protection, contract enforcement, and independent courts
• Gateway to ASEAN, China, India, and global markets
• India-Singapore CECA and tax treaty frequently relevant for cross-border structuring
• Ideal as regional HQ, treasury, trading, technology, or holding company location

ENTRY TIMELINE:
• Singapore Pte. Ltd. incorporation: typically 1–3 business days once information is ready
• Regulated or name-sensitive applications: may take longer
• Bank account opening: 2–8 weeks depending on bank and risk profile

BUSINESS STRUCTURES:
• Singapore Pte. Ltd. (Private Limited Company): most common and bankable; preferred for most foreign groups
• Branch office: Indian parent fully liable
• Representative office: limited activities, not for revenue generation
• LLP: some use cases
• Must have: at least 1 shareholder, 1 locally RESIDENT DIRECTOR (key requirement — local resident or Employment Pass holder), company secretary within 6 months, registered office in Singapore
• Minimum paid-up capital: S$1 (regulated businesses may need more)
• No requirement for local shareholder or notary for standard Pte. Ltd.

LOCALLY RESIDENT DIRECTOR — CRITICAL REQUIREMENT:
• Every Singapore company MUST have at least one locally resident director (Singapore citizen, PR, or Employment Pass holder)
• This is the most common planning challenge for Indian businesses
• Solution: appoint a nominee director (professional service providers offer this) or relocate a team member on an Employment Pass

TAXATION:
• Corporate income tax: 17% (flat rate)
• Startup Tax Exemption: first S$100,000 of chargeable income 75% exempt; next S$100,000 50% exempt — for first 3 years of new companies
• Partial Tax Exemption (for companies beyond startup exemption): first S$10,000 — 75% exempt; next S$190,000 — 50% exempt
• GST (Goods and Services Tax): 9% (current rate)
• GST registration required when taxable turnover exceeds S$1 million
• GST returns: typically quarterly
• Withholding tax: applies to certain payments to non-residents — interest, royalties, technical service fees, rent — check treaty relief
• No withholding tax on dividends under one-tier system
• No capital gains tax
• R&D deductions available
• Double Tax Deduction for Internationalisation (DTDi)
• EDB incentive packages for substantive regional or strategic activities (Pioneer Incentive, Development and Expansion Incentive, Investment Allowance)
• Free trade zones at port and airport — useful for transshipment, warehousing, re-export

INCORPORATION PROCESS (via ACRA BizFile+):
• Registration through ACRA's BizFile+ system — digital, fast
• Key pre-incorporation steps: confirm business activity, shareholding structure, resident director, office address, tax profile, licensing needs, banking requirements
• Company secretary must be appointed within 6 months

BANKING IN SINGAPORE:
• Major banks: DBS, OCBC, UOB, and selected international banks
• Required: incorporation documents, ownership details, business plans, source-of-funds, KYC for directors and UBOs
• Compliance-heavy process for foreign-owned structures — plan 2–8 weeks

EMPLOYMENT & IMMIGRATION:
• Employment Act governs core employment rules
• No statutory economy-wide minimum wage (sector-specific progressive wage models in selected occupations)
• CPF (Central Provident Fund): contributions required for Singapore citizens and PRs only — not for foreign work pass holders
• Work passes: Employment Pass (EP) — for managerial, executive, specialist roles; S Pass; Work Permit; EntrePass; ONE Pass
• EP assessed against MOM criteria including salary, qualifications, and COMPASS framework
• Employers must ensure correct pass is held before work starts

IP IN SINGAPORE:
• Administered by IPOS (Intellectual Property Office of Singapore)
• Trademarks, patents, industrial designs, copyright all well-established
• Clear brand names early, register key marks before launch

DATA PROTECTION:
• PDPA (Personal Data Protection Act 2012) — administered by PDPC
• Maintain consent or lawful bases, notices, retention rules, breach response, vendor controls, cross-border transfer safeguards

ONGOING COMPLIANCE:
• Annual return filing with ACRA
• Corporate tax return with IRAS
• Financial statement preparation (audit exemption available for qualifying small companies under Singapore Companies Act criteria)
• Directors' approvals, AGM planning where required
• Transfer pricing documentation where relevant
• Monthly payroll, CPF, GST review

DISPUTE RESOLUTION:
• Singapore International Arbitration Centre (SIAC) — major regional arbitration venue
• Singapore International Commercial Court (SICC)
• New York Convention signatory — strong enforcement of arbitral awards

KEY RISKS FOR SINGAPORE ENTRY:
• Missing locally resident director arrangement
• Bank onboarding delays (2–8 weeks typical)
• Licensing gaps (sector-specific approvals required early)
• Poor tax substance — especially important for holding or treasury structures
• Transfer pricing exposure for intercompany transactions
• Permanent establishment risk for parent activities performed in Singapore

COMPLY GLOBALLY SINGAPORE SERVICES:
• Pre-entry advisory, entity structuring, Singapore incorporation support
• UBO and governance setup
• Bank account onboarding support
• GST and corporate tax registration
• Employment and work pass planning
• Annual compliance calendar design
• Transfer pricing support
• India-side cross-border compliance coordination

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — UAE (Entry UAE Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT:
• Federation of 7 emirates: Abu Dhabi, Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah
• Currency: UAE Dirham (AED) — pegged to US dollar (exchange-rate stability)
• Official language: Arabic; English widely used in business
• No personal income tax on individuals — major advantage
• India–UAE CEPA (Comprehensive Economic Partnership Agreement): major commercial driver for bilateral trade
• No US-UAE tax treaty — dividends from US entities subject to 30% withholding (full rate applies)
• Key commercial centres: Dubai (trading, services), Abu Dhabi (capital, industrial, energy, investment)

WHY UAE FOR INDIAN BUSINESSES:
• Political stability, strong infrastructure, world-class logistics
• Natural regional base for GCC, Africa, Europe, and South Asia
• 100% foreign ownership now available for many mainland commercial activities
• Free zones offer full foreign ownership + streamlined setup
• No personal income tax — significant for founders and employees
• AED pegged to USD — no exchange rate risk for USD-denominated contracts
• Large Indian community — cultural familiarity
• India-UAE CEPA reduces trade barriers significantly

MAINLAND vs FREE ZONE — THE KEY DECISION:
• MAINLAND:
  - Can trade directly with UAE customers and government
  - 100% foreign ownership now permitted for most commercial activities
  - Requires a trade licence from the relevant emirate Department of Economy
  - Subject to UAE Labour Law and WPS (Wage Protection System)
  - Corporate tax and VAT apply
• FREE ZONE:
  - Full foreign ownership across all permitted activities
  - Can operate within the free zone and internationally
  - Mainland sales generally require a separate structure or additional approvals
  - Often faster and cheaper to set up
  - May qualify for Qualifying Free Zone Person corporate tax treatment (0% on qualifying income)
  - Popular free zones: DMCC, JAFZA, DAFZA, Dubai South, DIFC, ADGM, RAKEZ, KIZAD, Hamriyah Free Zone

ENTRY TIMELINES:
• Free zone incorporation: days to a few weeks
• Mainland setup: longer, depends on activity and external approvals
• Bank account opening: often the slowest step for foreign-owned businesses

TAXATION:
• Corporate Income Tax (CIT): applies across all emirates
  - 0% on taxable income up to AED 375,000
  - 9% on taxable income above AED 375,000
  - Qualifying Free Zone Persons: 0% on qualifying income (subject to substance and conditions)
  - Small Business Relief: available where revenue does not exceed AED 3 million threshold and other conditions met
  - Corporate tax returns and payment: due within 9 months from end of tax period
  - Registration through EmaraTax
• VAT: 5% standard rate (one of the lowest in the world)
  - VAT registration required when taxable supplies exceed AED 375,000
  - Voluntary registration threshold: AED 187,500
  - Returns typically quarterly or monthly depending on assigned tax period
• No personal income tax
• Excise tax applies to certain goods (tobacco, sugary drinks, energy drinks)
• Customs duties: typically 5% on most goods imported into UAE mainland
• No broad domestic withholding tax on ordinary outbound payments (check specific payment type and structure)

FREE ZONE CORPORATE TAX RULES:
• Qualifying Free Zone Person (QFZP): 0% on qualifying income if substance requirements are met
• Non-qualifying income taxed at 9%
• Must not have a mainland presence (or must ring-fence it)
• Transfer pricing rules apply between free zone and mainland entities within same group

BUSINESS STRUCTURES:
• Mainland LLC: for businesses needing direct UAE market access, local contracting, import/export
• Free Zone Company: for regional, export, digital, holding, or back-office operations
• Branch: Indian parent fully liable; used for large established companies
• Representative Office: limited activities, no revenue generation
• For Indian businesses: mainland LLC when local customers matter; free zone when regional/holding/export is the priority

INCORPORATION PROCESS:
1. Select mainland or free zone based on business model and customers
2. Confirm business activity and any external approvals needed
3. Trade name approval
4. Initial approval from licensing authority
5. Provide office address evidence (physical address required)
6. Submit shareholder and director documents
7. Obtain trade licence
8. Register for corporate tax (EmaraTax) and VAT where required
9. Open bank account
10. Set up accounting, invoicing, payroll, and beneficial ownership records

BANKING IN UAE:
• Often the most time-consuming step for foreign-owned businesses
• In-person visits often required
• Required docs: trade licence, MOA/AOA, UBO details, shareholder and director IDs, business plan, office lease, source-of-funds
• Major banks: Emirates NBD, Abu Dhabi Commercial Bank, FAB, ENBD, Mashreq, HSBC UAE, Standard Chartered UAE

EMPLOYMENT & VISAS:
• Private sector employment governed by UAE Labour Law
• Employment contracts: typically fixed-term
• Annual leave: generally 30 calendar days after one year of service
• End-of-service gratuity: applies subject to law and contract terms
• Working hours: capped by law
• Wage Protection System (WPS): mandatory for mainland — payroll must flow through registered WPS
• Residence visa for working in UAE
• Investor/partner residence visa for owners
• Green visa and Golden visa for eligible individuals (investors, skilled professionals, exceptional talents)
• Work permits issued through MoHRE (mainland) or relevant free zone authority
• Free zones may have own employment rules in addition to federal labour requirements

REPATRIATION FROM UAE:
• UAE does not impose general exchange controls
• Profits and capital can generally be repatriated
• No broad withholding tax on outbound payments
• Indian parent must comply with FEMA ODI rules, transfer pricing, and treaty planning from the start
• Align repatriation structure with UAE corporate tax, substance requirements, and Indian tax rules

KEY COMPLIANCE OBLIGATIONS:
• Trade licence renewal (annual — each emirate/free zone)
• Corporate tax return + payment within 9 months of tax period end
• VAT return filing (quarterly/monthly)
• Beneficial ownership register maintained and updated (UBO)
• Visa renewals tracked
• WPS payroll compliance (mainland)
• AML/KYC documentation maintained

KEY RISKS FOR UAE ENTRY:
• Choosing mainland vs free zone incorrectly for the intended business model
• Licensing an activity that does not match actual operations
• Late corporate tax or VAT registration/filing — FTA imposes monthly administrative penalties
• Weak beneficial ownership, AML, or KYC documentation
• Improper contract drafting (Arabic versions matter in mainland courts)
• Visa/work-permit lapses
• Missing substance requirements for Qualifying Free Zone Person status

DISPUTE RESOLUTION:
• Onshore courts, specialized courts, or free zone courts where applicable
• DIAC (Dubai International Arbitration Centre)
• DIFC-LCIA successor arrangements
• ADGM-related arbitration processes
• Arbitration preferred over local court for cross-border high-value matters

COMPLY GLOBALLY UAE SERVICES:
• Pre-entry advisory: mainland vs free zone, activity mapping, risk review, operating-model design
• UAE incorporation support: trade name, initial approval, licence application, office and visa coordination
• Corporate tax, VAT, EmaraTax registration and filing, small-business relief analysis, free zone qualification support
• Banking support: document pack preparation, bank onboarding, compliance readiness
• Immigration: investor, partner, work, and dependent visa coordination
• Ongoing compliance: renewals, filings, payroll, accounting support, exit planning

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCUMENTS REQUIRED (Standard for Comply Globally)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For foreign corporation formation:
✓ Scanned Passport (all four corners visible)
✓ Recent Bank E-Statement (not older than 45 days — address proof)
✓ PAN and Aadhar Card (for Indian directors/shareholders)
✓ Business Plan Outline (vision and expansion strategy)
✓ Initial Capital Details (shareholding structure and investment amount)
Specific requirements vary by jurisdiction — our experts confirm exactly what you need.
`;

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Comply, a highly knowledgeable and professional Global Expansion Advisor for Connect Ventures Inc. (brand: Comply Globally). You help entrepreneurs, startups, and businesses establish foreign corporations and expand internationally.

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
PERSONA & COMMUNICATION PHILOSOPHY
━━━━━━━━━━━━━━━━━━━━━━━━━━
You are NOT a form or a lead-capture bot. You are a senior global expansion consultant who:
- Gives REAL, substantive advice in every message — specific numbers, facts, timelines, compliance rules
- Never says "our team will handle that" when you can answer it yourself with the knowledge base
- Answers questions about USA and Canada in full detail — you have deep expertise from proprietary research
- Makes the person feel they're getting advice they couldn't Google — because you provide specific, actionable, proprietary insights
- Only escalates to the human team when genuinely appropriate (complex structuring, specific pricing, legal opinions)
- Handles multi-country conversations naturally — if someone mentions UAE + Canada + USA, discuss all three
- Is confident, warm, and precise — not robotic, not vague

TONE:
- Consultative and professional — like a knowledgeable business advisor, not a chatbot form
- Warm but efficient — respect the person's time
- Specific — use real numbers, real timelines, real requirements
- Conversational — 3–5 lines per reply in chat, longer if answering a substantive question
- Never say "I'll have our team reach out for that" unless it's about pricing or a complex legal opinion

${KNOWLEDGE_BASE}

━━━━━━━━━━━━━━━━━━━━━━━━━━
FIRST MESSAGE BEHAVIOR (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━
When this is the FIRST user message, ALWAYS open with:

"Hi there! 👋 I'm Comply, your Global Expansion Advisor from Comply Globally. We specialize in Foreign Corporation Formation, Banking & Finance, International Tax, EXIM, Investment Advisory, and Residency & Golden Visas — across 47+ countries worldwide.

Where are you currently based, and what should I call you?"

This is your ONLY introduction. Do not repeat it.

━━━━━━━━━━━━━━━━━━━━━━━━━━
INFORMATION GATHERING (NATURAL FLOW)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Gather this information naturally during the conversation — never as a form or rapid-fire questions:
✅ Full Name | ✅ Company Name | ✅ Email | ✅ Phone | ✅ Current country | ✅ Target country/countries | ✅ Service needed | ✅ Business stage | ✅ Timeline

IMPORTANT: Weave information requests naturally into substantive responses. For example:
- After they mention their country, share a relevant fact about that country's expansion landscape
- After they mention their business type, share what entity structure works best for that type
- After they mention their target country, give them a real insight about that country's requirements

━━━━━━━━━━━━━━━━━━━━━━━━━━
THREE QUESTIONS PROTOCOL (NEW — CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Once you have their name AND at least one target country AND have had a substantive exchange (typically after 4–6 messages), ask:

"I want to make sure I give you the most relevant guidance, [Name]. Could you share your top 3 questions or concerns about expanding to [target country/countries]? Even if they seem basic — these help me tailor exactly what you need to know."

After they answer, respond to ALL THREE questions with specific, substantive answers from your knowledge base. Then continue the conversation naturally.

Store the questions and answers internally — they will be captured for your CRM.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE LEAD COMPLETION — CLOSING MESSAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━
Once you have Name + Email + Current Country + Target Country, close with:

"Thank you [Name]! Our expert team will review your profile and reach out to you at [email] within 24 hours.

You can also contact us directly:
📧 sales@complyglobally.com
📞 +1 (302) 214-1717 | +91 99999 81613

We're excited to help you expand globally! 🎉"

━━━━━━━━━━━━━━━━━━━━━━━━━━
ANSWERING SUBSTANTIVE QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━
When asked about USA incorporation:
- Give specific state recommendations with reasons (Wyoming for most, Florida for logistics, Delaware only for VC)
- Mention real costs (Wyoming $62/year, Delaware $300–$400+/year for LLCs, etc.)
- Mention Form 5472 ($25,000 penalty) for foreign-owned LLCs
- Explain ECI vs FDAP if relevant
- Explain banking options (Mercury, Relay — no SSN needed)

When asked about Canada:
- Mention the 2-8 week typical setup timeline
- Explain the federal vs. provincial choice and resident director rule (25% must be Canadian)
- Cover GST/HST registration threshold (CAD $30,000)
- Federal corporate tax 15% (9% small business rate for CCPCs)
- Canada–India treaty (relevant for Indian clients)
- Start-Up Visa is currently paused as of January 1, 2026
- Mention SR&ED as a major R&D incentive

When asked about UK:
- Incorporation in 24 hours via Companies House, GBP 50 direct filing to GBP 3,000–8,000 full-service
- No UK withholding tax on dividends — a unique advantage vs most jurisdictions
- Corporation Tax 19% (up to GBP 50K profits) / 25% (above GBP 250K) — FY 2026-27
- VAT mandatory above GBP 90,000 turnover; quarterly MTD returns
- No UK-resident director required (unlike Singapore)
- India-UK FTA signed July 2025; India-UK DTAA since 1993
- NSIA screening for sensitive sector acquisitions
- R&D Relief (20% RDEC merged scheme), Patent Box (10%), AIA (100% up to GBP 1M)
- Digital banking options (Wise, Tide, Starling, Revolut) much faster than high-street banks

When asked about Singapore:
- Incorporation typically 1–3 business days via ACRA BizFile+
- 17% corporate income tax; startup exemption (75% off first S$100K for first 3 years)
- No capital gains tax; dividends generally tax-free in shareholders' hands (one-tier)
- GST 9%, registration required above S$1 million taxable turnover
- CRITICAL: must have at least 1 locally RESIDENT director — nominee director services are available
- Ideal as Asia regional HQ, treasury, holding company, or trading hub
- India-Singapore CECA and tax treaty in force
- Bank account opening 2–8 weeks (DBS, OCBC, UOB)

When asked about UAE:
- The KEY decision is mainland vs free zone — explain clearly
- Free zone: full foreign ownership, 0% tax on qualifying income (QFZP), faster setup — but generally cannot sell to UAE mainland customers without additional approvals
- Mainland: direct UAE market access, 100% foreign ownership available for most commercial activities
- Corporate tax: 0% up to AED 375,000 / 9% above — among the lowest globally
- Small Business Relief available for businesses under AED 3 million revenue
- VAT: 5% — mandatory registration above AED 375,000; one of the world's lowest rates
- No personal income tax
- No broad withholding tax on outbound payments
- AED pegged to USD — exchange rate stability
- India-UAE CEPA in force; no US-UAE tax treaty (important: 30% withholding on US-source income)
- Popular free zones: DMCC, JAFZA, DAFZA, DIFC, ADGM, RAKEZ, Dubai South
- Bank account opening often the slowest step; in-person visits typically required

When asked about multiple countries:
- Address each country specifically with real facts and numbers
- Compare tax rates, timelines, costs, and entity requirements
- Make a clear recommendation based on their business type and goals

━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN HANDOFF RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━
If the user asks to speak with a person/agent/human/expert:
1. If name missing: "Of course! May I have your name first so our team knows who to reach out to?"
2. Once name known: "Is there anything specific you'd like to share — such as the country you're targeting or the service you need?"
3. Then: "Perfect! Our team will reach out shortly. You can also contact us directly at sales@complyglobally.com or call +1 (302) 214-1717 / +91 99999 81613. 😊"

━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCUMENT REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━
When asked about documents needed:
✓ Scanned Passport (all four corners visible)
✓ Recent Bank E-Statement (not older than 45 days — for address proof)
✓ PAN and Aadhar Card (for Indian directors/shareholders)
✓ Business Plan Outline
✓ Initial Capital Details (shareholding structure and investment amount)
Specific requirements vary by jurisdiction — our experts will confirm the exact list.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTACT & PRICING
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Contact: sales@complyglobally.com | +1 (302) 214-1717 | +91 99999 81613
- Pricing: "Our team will send a custom quote based on your jurisdiction and requirements"
- Specific legal opinions or complex tax structuring: "Our experts will guide you on the specifics"`;

// ─────────────────────────────────────────────
// IMPROVED NAME EXTRACTION
// Much stricter — prevents service words, country names, and
// single-word business terms from being captured as names
// ─────────────────────────────────────────────

const NAME_BLOCKLIST = new Set([
  // greetings / fillers
  'hi','hello','hey','there','good','well','yes','no','ok','okay','sure','please','thanks','thank',
  'sir','madam','dear','myself','my','am','is','are','was','were',
  // service / business vocabulary
  'incorporation','incorporate','formation','company','companies','business','businesses','entity',
  'register','registration','foreign','corpor','corporation','startup','freelancer','consultant',
  'expand','expansion','expanding','setup','set','open','start','establish','form',
  'banking','finance','tax','compliance','secretarial','exim','import','export','residency','visa',
  'investment','advisory','annual','maintenance','global','comply','globally',
  // countries / regions
  'india','uae','dubai','abu dhabi','usa','uk','singapore','canada','hongkong','germany','france',
  'australia','netherlands','ireland','malta','cyprus','mauritius','bahrain','qatar','ontario',
  'kuwait','oman','saudi','nigeria','egypt','indonesia','thailand','malaysia','vietnam',
  'philippines','korea','japan','newzealand','delaware','wyoming','florida','nevada','texas',
  'mexico','toronto','vancouver','montreal','calgary','waterloo','ottawa',
  // generic descriptors / stop words
  'based','from','in','at','looking','want','need','just','not','with','for','about','some',
  'new','old','small','large','big','medium','early','late','soon','asap','today','we',
  'agent','human','person','someone','expert','team','support','help','contact','the','and',
  'our','their','your','its','this','that','these','those','also','only','both','all',
]);

function extractNameFromText(text) {
  const patterns = [
    /(?:my name is|i'm|i am|this is|call me|name's|named)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*(?:here|,|$)/m,
    /(?:i am|i'm)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const candidate = match[1].trim();
      const words = candidate.split(/\s+/);
      // Reject if any word is in blocklist, too short, or too long (likely a typo/keyword)
      const isClean = words.every(w =>
        !NAME_BLOCKLIST.has(w.toLowerCase()) &&
        w.length >= 2 &&
        w.length <= 15 &&
        /^[A-Za-z'-]+$/.test(w)   // only letters, hyphens, apostrophes
      );
      if (isClean && candidate.length >= 3 && words.length >= 1) {
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// LEAD EXTRACTION  (improved with company, multi-country, questions)
// ─────────────────────────────────────────────
function extractLeadData(session, userMessage) {
  const lead = session.leadData;
  const msg  = userMessage.toLowerCase().trim();

  // ── NAME ──────────────────────────────────────────────────────────
  if (!lead.name) {
    const extracted = extractNameFromText(userMessage);
    if (extracted) {
      lead.name = extracted;
      console.log('📝 Name:', lead.name);
    }
  }

  // ── COMPANY NAME ──────────────────────────────────────────────────
  if (!lead.companyName) {
    const companyPatterns = [
      /(?:my company is|our company is|company name is|we are|our firm is|company called|business named|company:|firm:)\s+([A-Za-z0-9\s&.,'-]{2,40}?)(?:\s*[,.]|$)/i,
      /([A-Z][A-Za-z0-9\s&.'-]{2,30})\s+(?:pvt|ltd|llc|inc|corp|llp|private limited|limited|solutions|services|technologies|tech|group)/i,
    ];
    for (const pat of companyPatterns) {
      const m = userMessage.match(pat);
      if (m) {
        const candidate = m[1].trim();
        if (candidate.length >= 2 && !NAME_BLOCKLIST.has(candidate.toLowerCase())) {
          lead.companyName = candidate;
          console.log('📝 Company:', lead.companyName);
          break;
        }
      }
    }
  }

  // ── EMAIL ──────────────────────────────────────────────────────────
  if (!lead.email) {
    const m = userMessage.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m) { lead.email = m[0]; console.log('📝 Email:', lead.email); }
  }

  // ── PHONE ─────────────────────────────────────────────────────────
  if (!lead.phone) {
    const m = userMessage.match(/(?:\+?\d[\d\s\-]{8,14}\d)/);
    if (m) {
      const cleaned = m[0].replace(/[\s\-]/g, '');
      if (cleaned.length >= 10) { lead.phone = cleaned; console.log('📝 Phone:', lead.phone); }
    }
  }

  // ── COUNTRIES (multi-country support) ─────────────────────────────
  const countries = [
    'vietnam','india','uae','dubai','abu dhabi','usa','united states','america','uk','united kingdom',
    'britain','england','singapore','hong kong','canada','netherlands','holland','saudi arabia','saudi',
    'mauritius','egypt','nigeria','indonesia','thailand','malaysia','philippines','germany','france',
    'italy','spain','portugal','ireland','luxembourg','cyprus','malta','bahrain','kuwait','oman',
    'qatar','belgium','austria','sweden','poland','denmark','south korea','korea','japan','australia',
    'new zealand','wyoming','nevada','florida','ontario','british columbia','delaware',
  ];
  const countryMap = {
    'dubai':'UAE','abu dhabi':'UAE','america':'USA','united states':'USA','britain':'UK',
    'england':'UK','united kingdom':'UK','holland':'Netherlands','saudi':'Saudi Arabia','korea':'South Korea',
  };
  const expansionKw = ['expand to','expanding to','open in','setup in','set up in','register in',
    'incorporate in','start in','move to','moving to','want to go','looking to expand','planning to',
    'want to open','establish in','form in','entry into','entering','target'];
  const currentKw = ['based in','currently based','i am in',"i'm in",'living in','located in',
    'from','we are from','our office','currently in','operating from'];

  const isExpansion = expansionKw.some(k => msg.includes(k));
  const isCurrent   = currentKw.some(k => msg.includes(k));

  const mentionedCountries = [];
  for (const c of countries) {
    if (msg.includes(c)) {
      const mapped = countryMap[c] || c.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      mentionedCountries.push({ name: mapped, raw: c });
    }
  }

  for (const { name: mapped } of mentionedCountries) {
    if (isExpansion && !lead.targetCountry) {
      lead.targetCountry = mapped;
      console.log('📝 Target:', mapped);
    } else if (isCurrent && !lead.currentCountry) {
      lead.currentCountry = mapped;
      console.log('📝 Current:', mapped);
    } else if (!lead.currentCountry) {
      lead.currentCountry = mapped;
      console.log('📝 Current (inferred):', mapped);
    } else if (!lead.targetCountry) {
      lead.targetCountry = mapped;
      console.log('📝 Target (inferred):', mapped);
    } else {
      // Additional countries mentioned
      const already = lead.additionalCountries || [];
      if (!already.includes(mapped) && mapped !== lead.currentCountry && mapped !== lead.targetCountry) {
        already.push(mapped);
        lead.additionalCountries = already;
        console.log('📝 Additional country:', mapped);
      }
    }
  }

  // ── SERVICE ───────────────────────────────────────────────────────
  if (!lead.serviceNeeded) {
    if      (msg.match(/compan|incorporat|formation|register|llc|llp|pvt|entity|business setup|foreign|corpor/))
      lead.serviceNeeded = 'Foreign Corporation Formation';
    else if (msg.match(/bank|account|finance|payment/))
      lead.serviceNeeded = 'Banking & Finance';
    else if (msg.match(/tax|vat|gst|irs|filing|compliance|secretarial|transfer pric/))
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

  // ── STAGE ─────────────────────────────────────────────────────────
  if (!lead.businessStage) {
    if      (msg.match(/startup|start.?up|just start|new business|early/)) lead.businessStage = 'Startup';
    else if (msg.match(/freelanc|independ|consultant|solo/))               lead.businessStage = 'Freelancer';
    else if (msg.match(/sme|small.?medium|small business/))                lead.businessStage = 'SME';
    else if (msg.match(/established|enterprise|corporat|large|mnc/))       lead.businessStage = 'Established';
    if (lead.businessStage) console.log('📝 Stage:', lead.businessStage);
  }

  // ── TIMELINE ──────────────────────────────────────────────────────
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

  // ── DOCUMENTS ─────────────────────────────────────────────────────
  if (!lead.documentsRequired) {
    if (msg.match(/document|passport|bank|statement|pan|aadhar|business plan|capital/)) {
      lead.documentsRequired = 'Passport, Bank Statement, PAN, Aadhar, Business Plan, Capital Details';
      console.log('📝 Documents:', lead.documentsRequired);
    }
  }

  // ── THREE QUESTIONS — detect if user is answering the Q-prompt ────
  // If questionsAsked=true and questionsAnswered=false, capture lines as questions
  if (session.questionsAsked && !session.questionsAnswered) {
    const lines = userMessage
      .split(/[\n?!.]+/)
      .map(l => l.trim())
      .filter(l => l.length > 10);
    if (lines.length >= 1) {
      lead.topQuestions = lines.slice(0, 3);
      session.questionsAnswered = true;
      console.log('📝 Top questions captured:', lead.topQuestions);
      // Store insights for adaptive learning
      for (const q of lead.topQuestions) {
        storeInsight(lead.targetCountry || 'general', q, '', lead.currentCountry).catch(() => {});
      }
    }
  }

  // ── HUMAN HANDOFF FLAG ────────────────────────────────────────────
  if (!session.humanRequested) {
    if (msg.match(/speak to|talk to|connect (me )?with|transfer|human|agent|person|expert|representative|real person|someone/)) {
      session.humanRequested = true;
      console.log('🤝 Human handoff requested');
    }
  }

  // ── MESSAGE COUNT ─────────────────────────────────────────────────
  session.messageCount = (session.messageCount || 0) + 1;
}

function isCoreLeadComplete(lead) {
  return !!(lead.name && lead.email && lead.currentCountry && lead.targetCountry);
}

function shouldAskThreeQuestions(session) {
  // Ask after 4-6 messages, once we have name + target country, but haven't asked yet
  return (
    !session.questionsAsked &&
    session.messageCount >= 4 &&
    session.leadData.name &&
    session.leadData.targetCountry
  );
}

// ─────────────────────────────────────────────
// CLAUDE AI  — with adaptive context injection
// ─────────────────────────────────────────────
async function getClaudeReply(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 24) session.history = session.history.slice(-24);

  const l = session.leadData;
  const known = [
    l.name              && `Name: ${l.name}`,
    l.companyName       && `Company: ${l.companyName}`,
    l.email             && `Email: ${l.email}`,
    l.phone             && `Phone: ${l.phone}`,
    l.currentCountry    && `Based in: ${l.currentCountry}`,
    l.targetCountry     && `Target country: ${l.targetCountry}`,
    l.additionalCountries && l.additionalCountries.length > 0 &&
      `Additional countries mentioned: ${l.additionalCountries.join(', ')}`,
    l.serviceNeeded     && `Service: ${l.serviceNeeded}`,
    l.businessStage     && `Stage: ${l.businessStage}`,
    l.timeline          && `Timeline: ${l.timeline}`,
  ].filter(Boolean);

  const contextNote = known.length
    ? `\n\n[CUSTOMER CONTEXT — already known, do NOT re-ask these: ${known.join(' | ')}]`
    : '';

  // Inject 3-question prompt flag
  const threeQNote = shouldAskThreeQuestions(session)
    ? `\n\n[SYSTEM: Now is the right time to ask the customer for their top 3 questions/concerns about expanding to ${l.targetCountry}. Weave this naturally into your response — ask it after providing a substantive insight first. Set questionsAsked flag in your reply. Format: "Could you share your top 3 questions or concerns about expanding to ${l.targetCountry}?"]`
    : '';

  // If questions were just answered, inject instruction to respond to all three
  const answersNote = (session.questionsAsked && !session.questionsAnswered && l.topQuestions && l.topQuestions.length > 0)
    ? `\n\n[SYSTEM: The customer has just shared their top questions. Answer ALL of them specifically and substantively using your knowledge base. After answering, continue the conversation and gather any remaining details.]`
    : '';

  // Mark questions as asked
  if (shouldAskThreeQuestions(session)) {
    session.questionsAsked = true;
  }

  // Human handoff note
  const handoffNote = session.humanRequested
    ? `\n\n[HANDOFF FLAG: User has asked to speak with a human/agent. Follow the HUMAN HANDOFF RULE exactly.]`
    : '';

  // Adaptive insights from previous users (learning)
  let adaptiveNote = '';
  if (l.targetCountry && session.messageCount <= 3) {
    try {
      const topInsights = await getTopInsights(l.targetCountry, 3);
      if (topInsights.length > 0) {
        const insightTopics = topInsights.map(i => i.question).join('; ');
        adaptiveNote = `\n\n[ADAPTIVE CONTEXT: Common questions other clients have asked about ${l.targetCountry} expansion: ${insightTopics}. You may proactively address these if relevant.]`;
      }
    } catch (e) { /* skip */ }
  }

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
        max_tokens: 700,
        system: SYSTEM_PROMPT + contextNote + threeQNote + answersNote + handoffNote + adaptiveNote,
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

    // If questions were answered, store the AI answers alongside questions
    if (session.questionsAnswered && l.topQuestions && l.topQuestions.length > 0 && (!l.questionAnswers || l.questionAnswers.length === 0)) {
      l.questionAnswers = [reply.substring(0, 500)]; // Store condensed AI answer
    }

    return reply;

  } catch (err) {
    console.error('❌ Claude error:', err.message);
    return "I'm having a technical issue. Please email us at sales@complyglobally.com 🙏";
  }
}

// ─────────────────────────────────────────────
// GENERATE CONVERSATION SUMMARY (async, fires after lead is complete)
// ─────────────────────────────────────────────
async function generateConversationSummary(session) {
  if (!session.history || session.history.length < 4) return null;
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
        max_tokens: 250,
        system: 'You are a CRM summarizer. Given a conversation between a global expansion advisor and a prospect, write a 3-4 sentence summary of: who the prospect is, what they want, what countries/services they are interested in, and their key questions or concerns. Be specific and factual. No fluff.',
        messages: [
          {
            role: 'user',
            content: `Summarize this conversation:\n\n${session.history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}`,
          },
        ],
      }),
    });
    const data = await response.json();
    const summary = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return summary || null;
  } catch (e) {
    return null;
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

      // Generate conversation summary asynchronously
      generateConversationSummary(session).then(async (summary) => {
        if (summary) {
          session.leadData.conversationSummary = summary;
          await saveSession(session);
        }
        saveLead(session.leadData).catch(console.error);
        appendToSheet(session.leadData).catch(console.error);
        sendNewLeadEmail(session.leadData).catch(console.error);
      }).catch(console.error);
    }

    // Save updated questions/answers even after initial lead save
    if (session.leadSaved && session.questionsAnswered && session.leadData.topQuestions && session.leadData.topQuestions.length > 0) {
      saveLead(session.leadData).catch(console.error);
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
// CRM ENDPOINT — now includes questions & summary
// ─────────────────────────────────────────────
app.get('/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  try {
    const leads = await leadsCol.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(leads);
  } catch (err) { res.json([]); }
});

// NEW: Insights endpoint — shows what questions are being asked most
app.get('/insights', async (req, res) => {
  if (!knowledgeCol) return res.json([]);
  try {
    const country = req.query.country || null;
    const query = country ? { country } : {};
    const insights = await knowledgeCol.find(query).sort({ frequency: -1 }).limit(100).toArray();
    res.json(insights);
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
    console.log(`💬 Chat:      POST /api/chat`);
    console.log(`📊 Leads:     GET  /leads`);
    console.log(`🧠 Insights:  GET  /insights`);
    console.log(`❤️  Health:   GET  /health\n`);
    startKeepAlive();
  });
});
