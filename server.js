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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — USA (Updated 2026 — Federal & State Compliance)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
COUNTRY SNAPSHOT (USA 2026):
• GDP: ~USD 29 trillion (world's largest economy)
• Indian-American community: 4.8+ million — highest-income ethnic group in the US
• Major hubs: NYC (finance/media), Silicon Valley (tech/VC), LA (entertainment/trade), Houston/Dallas (energy/HQs), Boston (biotech), Seattle (cloud/tech), Austin (startups), Miami (LatAm gateway)
• 60+ bilateral tax treaties including India-US DTAA (1989, 2006 protocol)
 
CRITICAL: US is a FEDERAL SYSTEM — 50 states each have their own corporate laws, tax codes, and filing requirements. A company must "foreign qualify" in every state where it has nexus (employees, offices, inventory, significant sales).
 
ENTITY TYPES FOR FOREIGN/INDIAN FOUNDERS:
• C-Corporation: 21% federal CIT. Required for VC fundraising or IPO. Can issue preferred shares and stock options. QSBS: up to $10M capital gains excluded if held 5+ years. Double taxation applies (21% corporate + dividend WHT).
• LLC (Single-Member, foreign-owned): Disregarded entity — no US corporate tax. 100% foreign ownership allowed. MUST file Form 5472 annually (penalty $25,000 per form per failure if missed — strictly enforced since 2017).
• LLC (Multi-Member): Taxed as partnership (Form 1065). Flexible profit allocation.
• S-Corporation: NOT available to foreign/Indian founders — requires all shareholders to be US citizens or permanent residents.
• Branch Office: Parent (Indian company) fully liable for US branch income; subject to 30% Branch Profits Tax (reduced to 15% under India-US DTAA).
 
STATE COMPARISON TABLE:
State | CIT Rate       | Key Advantage                     | Best For
DE    | 8.7% (nexus)   | Court of Chancery; DGCL; VC       | VC-funded startups; holding cos
WY    | 0%             | No CIT; privacy; $62/yr fee       | LLCs; holding cos; privacy
NV    | 0% (GRT)       | No CIT; asset protection           | Asset protection; gaming
CA    | 8.84%          | Largest market; tech ecosystem     | Tech cos operating in CA
NY    | 6.5-7.25%      | Financial/media capital            | Finance; media; large enterprises
TX    | 0% (margin)    | Large market; energy               | Energy; manufacturing; HQs
FL    | 5.5%           | No personal income tax; ports      | LatAm trade; logistics
WA    | 0% (B&O)       | No personal income tax; tech       | Tech; cloud; Amazon ecosystem
NM    | 0% franchise   | Absolute cheapest state            | Digital business; cost minimize
 
ANNUAL STATE FEES:
• Delaware Corp: $400 minimum (can reach $50,000–$200,000+ via Authorized Shares Method — use Assumed Par Value method to reduce). Delaware LLC: $300/year flat.
• Wyoming LLC: $62/year flat — most cost-effective
• Nevada LLC: $200/year + mandatory state business license
• Florida LLC: $138.75 annual report (no franchise tax for LLCs)
• New Mexico LLC: $0 annual report, no franchise tax — absolute cheapest
 
FEDERAL CORPORATE TAX (2026):
• C-Corp federal CIT: 21% flat on worldwide income
• Pass-through (LLC): 0% entity level; 10-37% individual
• Corporate AMT (CAMT): 15% on AFSI for large corporations
• BEAT (Base Erosion): 10% anti-base erosion tax on deductible payments to related foreign persons
• GILTI: 10.5% effective rate on global intangible low-taxed income of CFCs
• FDII: 13.125% effective rate on foreign-derived intangible income (export incentive)
• Branch Profits Tax: 30% (treaty: 15% under India-US DTAA)
• Bonus Depreciation: 100% (permanent OBBBA) — immediate expensing of qualifying assets
• Section 179 expensing: max $2.56M (2026), phaseout starts at $4.09M
 
WITHHOLDING TAX — INDIA-US DTAA RATES:
• Dividends (10%+ ownership): 30% domestic → 15% treaty
• Dividends (portfolio): 30% domestic → 25% treaty
• Interest (general): 30% domestic → 15% treaty
• Interest (bank/financial): 30% domestic → 10% treaty
• Royalties (general): 30% domestic → 15% treaty
• Royalties (equipment): 30% domestic → 10% treaty
• Fees for Included Services: 30% domestic → 15% treaty (if "make available" test met)
• Branch Profits Tax: 30% domestic → 15% treaty
 
SALES TAX — WAYFAIR NEXUS:
• No federal sales tax. 45 states + DC levy their own (0% to 7.25%+ base rate).
• Post-Wayfair (2018): states can impose sales tax on remote sellers meeting economic nexus thresholds (typically ~$100K sales or 200 transactions in the state).
• Indian companies selling online to US customers must assess state sales tax nexus from day one.
• Tools: Avalara, TaxJar for multi-state compliance.
 
EMPLOYMENT & IMMIGRATION FOR INDIAN NATIONALS:
• H-1B: specialty occupation visa (lottery-based annual cap, employer-sponsored)
• L-1: intra-company transfer (executives, managers, specialized knowledge)
• O-1: extraordinary ability
• E-2: treaty investor — NOT available to Indian nationals (India has no E-2 treaty with US)
• EB-5: immigrant investor (green card)
• Federal minimum wage: $7.25/hour (many states require more)
• FICA (2026): Social Security 6.2% employer + 6.2% employee on wages up to $184,500; Medicare 1.45% each (no wage cap)
 
BANKING FOR FOREIGN FOUNDERS (no SSN required):
• Mercury (Fintech): No SSN, no in-person, EIN only, $0/month — BEST OVERALL
• Relay (Fintech): No SSN, multiple sub-accounts, $0–$30/month
• Brex (Fintech): No SSN, great for spend management
• Wise Business: No SSN, best for FX transfers
• Chase/Bank of America: SSN preferred, often requires in-person — not feasible remotely
 
EIN (Federal Tax ID) FOR FOREIGN NATIONALS:
• Method 1 (Fastest): Call IRS International +1 (267) 941-1099, Mon–Fri 6am–11pm ET — get EIN same day
• Method 2 (4–6 weeks): Complete IRS Form SS-4, fax to +1 (304) 707-9471
• Method 3: Via registered agent or formation service ($50–$150)
 
FORM 5472 — MOST DANGEROUS COMPLIANCE TRAP:
• Foreign-owned SMLLC must file Form 5472 + pro forma Form 1120 annually
• Due April 15 (or September 15 with extension)
• Reports all transactions between owner and LLC (capital contributions, distributions, loans)
• Penalty: $25,000 per form per year — actively enforced since 2017
 
KEY ANNUAL COMPLIANCE DEADLINES (US):
• Jan 31: W-2s to employees; 1099s to contractors; Form 941 Q4
• Mar 1: Delaware Franchise Tax + Annual Report due (corporations)
• Apr 15: Federal C-Corp return (Form 1120) + Form 5472; FBAR due; state CIT returns (most states)
• Jun 1: Delaware LLC Annual Tax ($300)
• Jun 15: 2nd quarter estimated federal CIT
• Sep 15: 3rd quarter estimated; Extended S-Corp/Partnership returns
• Oct 15: Extended federal C-Corp return (Form 1120); Extended FBAR
• Dec 31: End of US federal tax year; Indian parent APR to RBI due
 
POST-INCORPORATION CHECKLIST (USA):
• Obtain EIN (IRS phone +1-267-941-1099)
• Monitor FinCEN BOI rules (current interim rule exempts US-formed entities; rules can change — verify before filing)
• Open Mercury or Relay business bank account
• Draft Operating Agreement (LLC) or Bylaws (Corp)
• Set up bookkeeping: QuickBooks, Xero, or Wave
• Register for state sales tax where economic nexus exists (Avalara or TaxJar recommended)
• Engage US CPA for annual filings (Form 5472 / 1120 / 1065)
• Apply for ITIN to claim tax treaty benefits
• File FEMA ODI (Form FC through AD bank in India) before first capital remittance
 
DATA PRIVACY (USA):
• No single federal privacy law. Complex patchwork: HIPAA (healthcare), GLBA (financial), COPPA (children under 13), FERPA (education)
• State privacy laws (20+ states as of 2026): California CCPA/CPRA (most comprehensive — applies to >$25M revenue or processing data of 100K+ CA consumers), Virginia VCDPA, Colorado CPA, Texas TDPSA, and growing list of state laws
• Indian companies serving US consumers must map which state laws apply based on customer locations and revenue thresholds
 
COMPLIANCE PENALTY MATRIX (USA):
• Form 1120 (CIT) late filing: 5% of unpaid tax per month (max 25%) + interest
• Form 5472 late/non-filing: $25,000 per return per failure (strict liability)
• Form 941 (Payroll) late deposit: 2-15% penalty on deposits + interest
• Delaware Franchise Tax late payment: $200 penalty + 1.5% monthly interest; risk of dissolution
• Delaware Annual Report non-filing: voiding of corporate charter after 2 years
• Sales tax non-filing: back taxes + penalties + interest; personal liability possible
• Employment tax (FICA) non-deposit: Trust fund recovery penalty (100% of unpaid tax)
• State privacy law (CCPA) violation: $2,500-7,500 per intentional violation; private right of action for data breaches
• Transfer pricing non-arm's length: 20-40% penalty + interest
• FCPA violation: criminal up to $250K fine + imprisonment; civil: disgorgement + penalties
 
CFIUS (FOREIGN INVESTMENT REVIEW):
• Mandatory filings for investments in critical technologies (TID US businesses), critical infrastructure (telecom, energy, water, financial), or sensitive personal data of US citizens
• Restricted sectors: domestic airlines (25% foreign voting equity cap), banking (regulator approval required), broadcasting/telecom (FCC restrictions), maritime shipping (Jones Act), nuclear energy, government contractors
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — PHILIPPINES (Entry Philippines Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
COUNTRY SNAPSHOT (Philippines 2026):
• GDP: ~USD 435 billion (2024); upper middle-income emerging economy
• Population: 115+ million; median age ~26 years; literacy rate >96%; English widely spoken in business and government
• Key hubs: Metro Manila (NCR — primary), Cebu, Clark/Subic, Davao
• Services = ~60% of GDP; world leader in BPO/IT-BPM
• Member of ASEAN, APEC, WTO; 43+ Double Tax Agreements (DTAs) including India, US, Japan, Singapore, UK, Germany, China
• Philippine Peso (PHP) is the national currency
• Regulatory bodies: SEC (corporate registration), BIR (tax), BSP (central bank/forex), BOI, PEZA, ARTA
 
WHY PHILIPPINES FOR FOREIGN/INDIAN BUSINESSES:
• Large consumer market (115M people), young English-proficient workforce
• Competitive labor costs; strategic Southeast Asian location
• Growing digital economy; global leader in BPO/IT-BPM
• PEZA and BOI offer major tax incentives (income tax holidays, 5% special CIT in lieu of all taxes)
• Progressive FDI liberalization under RA 11647 (2022) and RA 11659 (Public Service Act)
• 100% foreign ownership now permitted in most sectors except those on the Foreign Investment Negative List (FINL)
 
ENTRY TIMELINES (Philippines):
• Foreign-owned corporation setup: 4-8 weeks (SEC registration, BIR enrollment, LGU permits)
• PEZA-registered entities: additional 4-6 weeks for zone accreditation
• Setup cost: USD 3,000 to USD 10,000 depending on structure and complexity
• ARTA mandates processing time limits: 3 working days (simple), 7 (complex), 20 (highly technical)
 
BUSINESS STRUCTURES:
Structure         | Min Capital     | Tax Treatment        | Notes
Subsidiary (100%) | USD 200,000*    | 25% CIT on PH income | Most common; PEZA/BOI eligible
Branch Office     | USD 200,000     | 25% CIT + 15% BPRT   | Parent fully liable
Rep/Liaison Office| USD 30,000/yr   | Exempt (no income)   | Liaison only; no revenue
ROHQ              | USD 200,000     | Special rates         | Qualifying services to affiliates
 
*Reduced to USD 100,000 if technology-intensive or employs at least 50 Filipino workers
 
FOREIGN INVESTMENT NEGATIVE LIST (FINL):
• List A: Restricted by Constitution/law (e.g., mass media, small-scale mining, private security agencies — specific equity caps)
• List B: Restricted for security/defense/health/morals — Filipino ownership required if paid-up capital < USD 200,000
• RA 11659 (2022) liberalized public utilities — up to 100% foreign in non-critical utilities
• Advertising: 30% foreign equity cap remains
• Land: foreign nationals CANNOT own land; long-term leases up to 75 years permitted; condominiums up to 40% of building
 
CORPORATE INCOME TAX (Philippines):
Entity Type              | Rate  | Tax Base              | Notes
Domestic Corporation     | 25%   | Worldwide income      | Standard
Small Domestic Corp      | 20%   | Net taxable income    | Net income ≤ PHP 5M AND total assets ≤ PHP 100M
Resident Foreign Corp    | 25%   | PH-sourced income     | Engaged in trade/business in PH
Non-Resident Foreign     | 25%   | Gross PH income       | WHT-based collection
PEZA-registered          | 5% GIT| Gross income          | In lieu of ALL national and local taxes
BOI (ITH period)         | 0%    | N/A                   | 4-7 year income tax holiday
 
VAT (Philippines):
• Standard rate: 12%
• VAT registration mandatory when annual gross sales/receipts exceed PHP 3 million
• Export sales: zero-rated (0%)
• VAT-exempt: agricultural products in original state, educational services, residential leases <PHP 15,000/month
• Input VAT credited against output VAT
 
WITHHOLDING TAX RATES (Philippines):
Payment Type             | Domestic | Non-Resident | Treaty Range
Dividends                | 10% final| 25% final    | 5-15% (treaty)
Interest                 | 20% final| 25% final    | 10-15% (treaty)
Royalties                | 20% final| 25% final    | 10-25% (treaty)
Management/Technical Fees| 5-15% CWT| 25%         | Treaty may reduce
Branch Profit Remittance | N/A      | 15%          | May be reduced by treaty
 
CREATE MORE ACT INCENTIVES (RA 12066):
• Income Tax Holiday (ITH): 4-7 years for qualifying Registered Business Enterprises (RBEs)
• Special Corporate Income Tax (SCIT): 5% of gross income earned for 10 years after ITH (in lieu of all national and local taxes)
• Enhanced Deductions: additional 50-100% on power, labor, R&D, training, domestic input expenses
• Import duty exemption on capital equipment and raw materials
• VAT zero-rating on local purchases for qualifying RBEs
• Priority sectors under SIPP: IT-BPM/BPO, manufacturing, agribusiness, renewable energy, electric vehicles, healthcare, creative industries
 
PEZA ZONES (Philippines):
• PEZA operates 400+ economic zones: IT Parks/Centers (BPO/IT companies), Manufacturing Economic Zones, Agro-Industrial Zones, Tourism Zones
• Notable zones: Clark Freeport Zone, Subic Bay Freeport, Cebu IT Park, Laguna Technopark
• Metro Manila key districts: Makati CBD, Bonifacio Global City (BGC/Taguig), Ortigas Center
 
INCORPORATION PROCESS (Philippines):
1. SEC name verification via eSPARC system (1-2 days)
2. Prepare Articles of Incorporation and By-Laws (3-5 days)
3. Open bank account and deposit paid-up capital (3-7 days)
4. File with SEC and obtain Certificate of Incorporation (3-8 days)
5. Obtain Barangay Clearance (1-2 days)
6. Obtain Mayor's Permit/Business Permit from LGU (5-10 days)
7. Register with BIR — TIN + Certificate of Registration Form 2303 (3-5 days)
8. Register books of accounts with BIR (1-2 days)
9. Register with SSS, PhilHealth, Pag-IBIG (2-5 days)
10. Register with DOLE if hiring employees (1-2 days)
 
EMPLOYMENT & PAYROLL (Philippines):
• 8-hour work day / 48-hour work week; overtime at 25% (30% on holidays)
• 13th month pay: MANDATORY (1/12 of annual basic salary, paid before Dec 24)
• Minimum 5 days Service Incentive Leave (SIL)
• SSS employer contribution: 8.5-9.5% of monthly salary credit
• PhilHealth: total 5% of basic salary (employer + employee share equally)
• Pag-IBIG: 2% of basic salary (employer contribution capped PHP 200/month)
• Termination: requires just or authorized cause + due process; severance 1/2 to 1 month per year of service
 
IMMIGRATION FOR FOREIGN NATIONALS (Philippines):
• Alien Employment Permit (AEP): from DOLE — standard route (~2 weeks processing)
• 9(g) Pre-Arranged Employment Visa: for longer-term employment (2-3 months processing)
• Special Investor's Resident Visa (SIRV): for investments ≥ USD 75,000
• PEZA Working Visa: for employees of PEZA-registered companies
• Special Visa for Employment Generation (SVEG)
 
BANKING (Philippines):
• Major banks: BDO, BPI, Metrobank, Landbank; Foreign banks: Citibank, HSBC, Standard Chartered
• Required: SEC Certificate of Registration, Articles of Incorporation, Board Resolution, BIR Form 2303, valid IDs + passports of signatories and UBOs, proof of address
• BSP registration required for full repatriation rights at prevailing exchange rate
 
DATA PROTECTION (Philippines):
• Data Privacy Act of 2012 (RA 10173), enforced by National Privacy Commission (NPC)
• Registration required for data processing systems handling >1,000 individuals
• Data Protection Officer (DPO) appointment mandatory
• Breach notification within 72 hours to NPC and affected individuals
• Cross-border transfers permitted with adequate protection or NPC-approved safeguards
• Penalties: PHP 500K – 5M fine + imprisonment for violations
 
COMPLIANCE CALENDAR (Philippines — Key Deadlines):
• Jan 20: Mayor's Permit renewal deadline (LGU)
• Jan 31: Annual Registration Fee (BIR 0605); Annual Info Return 1604-C and 1604-F with Alphalists
• Mar 1: Annual Info Return - Creditable WHT (BIR 1604-E)
• Apr 15: Annual Income Tax Return (BIR 1702); Transfer Pricing documentation due
• Apr 30: Audited Financial Statements filing with SEC (for Dec fiscal year-end)
• Within 30 days of AGM: General Information Sheet (GIS) to SEC
• Monthly (10th): WHT on Compensation, EWT, FWT
• Monthly (20th): Monthly VAT Declaration
• Monthly (last day): SSS, PhilHealth, Pag-IBIG contributions
• Quarterly (60 days after quarter): Quarterly Income Tax Return; Quarterly VAT Return (25th day after quarter)
 
COMPLIANCE PENALTIES (Philippines):
• Income Tax Return late filing: 25% surcharge + 12% interest p.a. + compromise penalty
• VAT return late: 25% surcharge + 12% interest p.a.
• Withholding Tax late remittance: 25% surcharge + 12% interest + possible criminal liability
• Books of Accounts failure: PHP 10,000 – 50,000 + closure risk
• SEC Annual Filings (GIS/AFS) late: monetary penalty per day of delay
• Business Permit operating without: closure order + fines from LGU
• SSS contributions late: 3% monthly penalty
• PhilHealth late: 2% monthly penalty
• Data Privacy violation/breach: PHP 500K – 5M fine + imprisonment
 
EXIT OPTIONS (Philippines):
• Share sale: 15% capital gains tax on shares of non-listed domestic corporations
• Voluntary dissolution: requires 2/3 stockholder vote + SEC approval
• Cross-border mergers possible under Revised Corporation Code (RA 11232)
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — THAILAND (Entry Thailand Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
COUNTRY SNAPSHOT (Thailand 2026):
• GDP: ~USD 575 billion (2025); ASEAN's 2nd-largest economy (after Indonesia)
• Population: 71.7 million; well-educated; improving English proficiency
• Currency: Thai Baht (THB); GDP growth ~2-3%; inflation ~1-2%
• Key hubs: Bangkok (finance/commerce); Eastern Economic Corridor/EEC — Chonburi, Rayong, Chachoengsao (high-tech manufacturing); Chiang Mai (tech/creative); Phuket (tourism)
• Indian community: 25,000+; major Indian companies (Tata, Mahindra, Reliance, L&T, Birla) have Thailand operations
• India-Thailand DTAA: originally 1986, comprehensively revised 2015 (effective Jan 1, 2016)
• Trade: ASEAN member; RCEP (2022); ASEAN-India FTA/AIFTA (2010); 61 Double Tax Treaties
• CRITICAL 2026 CHANGE: DBD Biz Regist digital platform MANDATORY from 1 January 2026 — all physical company registrations discontinued
• World's 10th largest automotive producer; major manufacturing hub for electronics, hard disk drives
 
WHY THAILAND FOR INDIAN BUSINESSES:
• ASEAN's 2nd-largest economy; strategic Southeast Asian hub
• BOI incentives: up to 13 years CIT exemption for promoted activities
• Eastern Economic Corridor (EEC) — enhanced incentives for EV, digital, biotech, robotics, aerospace
• Consumer market of 72 million + 30M+ tourists annually
• Strong India-Thailand ties via AIFTA and revised DTAA
• No withholding tax advantage on dividends under DTAA (10%)
 
CRITICAL: FOREIGN BUSINESS ACT (FBA) — OWNERSHIP RESTRICTIONS:
• A company is "foreign" if 50%+ shares held by non-Thais
• FBA restricts majority foreign ownership in three lists:
  - List 1: Strictly prohibited (newspapers, rice farming, land trading)
  - List 2: Requires Cabinet approval (domestic transport, mining, manufacturing of firearms)
  - List 3: Requires Foreign Business Licence (FBL) from DBD (most professional services, wholesale, retail, construction, tourism services)
• Standard structure without BOI/FBL: 49% foreign / 51% Thai — most common for non-qualifying activities
• DBD Order 2/2568 (effective 1 Jan 2026): Thai shareholders MUST provide 3 months' bank statements proving financial capacity — specifically targets nominee shareholder arrangements. Also applies to companies where a foreign national holds authorised director/signatory authority.
• 2026: Thailand removed 10 business categories from FBA restrictions
 
PATHWAYS TO 100% FOREIGN OWNERSHIP (Thailand):
1. BOI Promotion (most common and recommended for high-tech/strategic sectors)
2. Foreign Business Licence (FBL) from DBD — discretionary, takes 4-6 months
3. Industrial Estate Authority of Thailand (IEAT) incentives
4. US-Thailand Treaty of Amity — available ONLY to US companies, NOT Indians
 
BOI (Board of Investment) — ESSENTIAL FOR INDIAN BUSINESSES:
• BOI-promoted companies: 100% foreign ownership + major tax benefits
• CIT exemption: 3-13 years (EEC activities get maximum — up to 13 years + 50% reduction for 5 more years)
• Import duty exemptions on machinery and raw materials for export
• Land ownership rights for BOI-promoted activities (normally foreigners cannot own Thai land)
• Unrestricted capital and dividend repatriation
• Smart Visa (up to 4 years) for foreign professionals in BOI activities
• LTR Visa (10 years) for qualifying investors and skilled professionals
• 2023-2027 BOI priorities: Bio-Circular-Green (BCG) economy, EVs, digital/electronics, advanced manufacturing, medical, creative industries
• EEC industries: next-gen automotive (EV), smart electronics, advanced tourism, agribusiness, food, robotics, aviation, biofuels, digital, medical hub
 
CORPORATE INCOME TAX (Thailand 2026):
Taxpayer/Profit Band              | CIT Rate     | Notes
Standard (most companies)         | 20%          | Flat rate on net taxable profits
SME — first THB 300,000 profit    | 0%           | SME = paid-up capital ≤ THB 5M AND revenue ≤ THB 30M
SME — THB 300,001–3,000,000       | 15%          | Progressive for qualifying SMEs
SME — above THB 3,000,000         | 20%          | Standard rate
BOI-promoted activities           | 0%           | CIT exemption during promotion (3-13 years)
Special Economic Zones            | 10%          | 10 consecutive accounting periods (approved 2025)
International Business Center     | 3-8%         | Based on local expenditure
Pillar Two Top-up Tax             | 15% minimum  | Large MNEs, consolidated revenue >EUR 750M (from 2025)
 
VAT (Thailand 2026):
• Standard rate: 7% (currently extended by Royal Decree No. 799 until 30 September 2026 — may revert to 10% statutory rate after Sep 30, 2026 — IMPORTANT planning point)
• Registration mandatory when annual revenue exceeds THB 1.8 million
• Exports: zero-rated (0%)
• Monthly VAT returns (PP.30) due by 15th of following month (23rd if e-filing)
• Foreign digital service providers with >THB 1.8M revenue from Thai customers must register for VAT (since 2021)
• From 18 Feb 2025: VAT applies to low-value imports (<THB 1,500) through e-commerce platforms
 
WITHHOLDING TAX RATES — INDIA-THAILAND DTAA (revised 2015):
Payment Type                | Thai Domestic Rate | To Indian Residents (DTAA)
Dividends                   | 10% final WHT      | 10% (same — capped under DTAA)
Interest (general)          | 15% final WHT      | 10% (capped under DTAA)
Royalties                   | 15% final WHT      | 10% (capped under DTAA)
Service fees (to companies) | 3% creditable      | Business profits rules apply
Rent (immovable property)   | 5% creditable      | 10% DTAA if real property
Branch Profit Remittance    | 10% final          | Reduced under DTAA for Indian residents
 
BUSINESS STRUCTURES (Thailand):
Structure                   | Foreign Cap | CIT           | Notes
Ltd Co (49% foreign)        | 49% FBA cap | 20%           | Standard; genuine 51% Thai shareholders needed
BOI-promoted Ltd (100%)     | Up to 100%  | 0% for 3-13yr | Best path for eligible activities
Branch Office (FBL needed)  | 100%        | 20% on Thai   | THB 3M min capital; FBL required
Representative Office       | N/A         | None          | Non-revenue; liaison/market research only
International Business Ctr  | 100%        | 3-8%          | Treasury/service functions for MNCs
 
MINIMUM CAPITAL (Thailand):
• THB 2 million per foreign work permit — CRITICAL. Need 4 foreign staff = THB 8M minimum paid-up capital.
• Branch office: THB 3 million
• Representative office: THB 3 million (across 5 years)
 
INCORPORATION PROCESS (Thailand — 2026):
1. Name reservation via DBD Biz Regist platform (mandatory digital — same day)
2. Prepare MOA, AOA, Shareholders' List, Directors' Forms (3-5 days)
3. File MOA registration via DBD Biz Regist (same day)
4. Hold Statutory Meeting; adopt AOA; appoint directors/auditor (same day)
5. File Company Registration online via DBD Biz Regist (1-3 days)
6. Apply for BOI promotion if eligible — STRONGLY RECOMMENDED (4-8 weeks)
7. Apply for FBL if 100% foreign and no BOI (4-6 months — rarely used)
8. Register for tax ID and VAT with Revenue Department (1-2 weeks)
9. Register with Social Security Office (within 30 days of first hire)
10. Open Thai bank account — LONGEST STEP (4-12 weeks)
11. Apply for Work Permits and Non-Immigrant B Visas for foreign staff (2-6 weeks each)
 
TOTAL TYPICAL TIMELINE:
• Limited Company (49% foreign): 2-4 weeks registration + 4-12 weeks banking = 6-16 weeks operational
• BOI-promoted company: 4-8 weeks BOI + registration + 4-12 weeks banking = 10-24 weeks
 
BANKING IN THAILAND:
• Typical time for foreign-owned entities: 4-12 weeks — the longest step
• In-person visits often required; rigorous AML/KYC
• Required: DBD Bor Or Jor 5 & 6, MOA/AOA, shareholders' and directors' lists, board resolution, ID for directors and UBOs, proof of Thai registered office, business plan, source of funds, parent company docs (legalized/apostilled from India)
• Major Thai banks: Bangkok Bank (BBL), Kasikornbank (KBANK), SCB, Krungthai Bank (KTB), Bank of Ayudhya (BAY)
• International banks: HSBC, Standard Chartered, Citi Thailand
• BOI certification and physical Thai presence significantly improve bank approval chances
 
EMPLOYMENT & PAYROLL (Thailand):
• Standard work week: 48 hours (8 hours/day, 6 days) or 40-45 hours in office/commercial work
• Minimum 6 days paid annual leave (increases with tenure)
• Statutory minimum wage: ~THB 354-400/day in 2026 (varies by province)
• SSS: 5% employer + 5% employee on salary capped at THB 15,000/month (max THB 750 each)
• Workmen's Compensation Fund: 0.2-1.0% of payroll (employer only)
• Annual statutory audit: MANDATORY for ALL Thai limited companies regardless of size
• Accounting records: must be maintained in Thai language; retained minimum 5 years
• Monthly WHT returns (PND.1, PND.3/53): due 7th of following month (15th if e-filing)
• Annual PIT summary (PND.1Kor): due by end of February
 
IMMIGRATION FOR INDIAN NATIONALS (Thailand):
1. Non-Immigrant B Visa + Work Permit: standard route
   - THB 2M paid-up capital required per foreign work permit
   - 4:1 Thai-to-foreign employee ratio (non-BOI companies)
   - Minimum salary for Indians: ~THB 50,000/month
2. BOI Visa + Work Permit: streamlined for BOI-promoted companies; faster e-WP/e-Visa; no strict 4:1 ratio
3. Smart Visa: for experts, executives, investors, startups in 13 target industries (up to 4 years, no separate work permit needed for associated employment)
4. Long-Term Resident (LTR) Visa: 10 years for wealthy global citizens, wealthy pensioners, work-from-Thailand professionals, highly skilled professionals
5. Elite Visa: 5-20 years for high-net-worth individuals
 
COMPLIANCE CALENDAR (Thailand — Key Dates):
• Monthly (7th/15th): PND.1 (PIT WHT), PND.3/53 (Corporate WHT) — 7th deadline extends to 15th for e-filing
• Monthly (15th/23rd): VAT return PP.30 — 15th extends to 23rd for e-filing
• Monthly (15th): SSS contributions
• February (mid-Feb): Issue Withholding Tax Certificates (50 Bis) to employees
• Feb 28/29: PND.1Kor annual PIT summary
• March 31: Individual PIT returns (PND.90/91)
• April 30: AGM deadline for December fiscal year-end companies (within 4 months of FY end)
• May 14: BJ.5 List of Shareholders filing with DBD (within 14 days of AGM)
• May 31: PND.50 Annual CIT Return for December FY companies (within 150 days)
• August 31: PND.51 Half-year CIT Prepayment for December FY companies
• September 30: VAT 7% rate reduction expires — watch for Royal Decree extension
 
REPATRIATION FROM THAILAND:
• Dividend: 10% final WHT (10% under India-Thailand DTAA — same rate, but payable)
• Interest: 15% WHT (10% under DTAA)
• Royalty: 15% WHT (10% under DTAA)
• Foreign Exchange Transaction Form required for amounts >USD 200,000
• BOI-promoted companies: unrestricted capital and dividend repatriation
• Indian parent: must comply with FEMA ODI reporting, claim FTC under Section 90/Rule 128
 
KEY RISKS FOR THAILAND (INDIANS):
• FBA nominee shareholder arrangements: ILLEGAL — imprisonment up to 3 years + THB 100K-1M fine + company dissolution
• DBD Order 2/2568: Thai shareholders must provide bank statements from Jan 1, 2026 — nominees cannot comply
• BOI condition non-compliance: withdrawal of benefits + retrospective tax collection
• Pillar Two Top-up Tax for large MNE groups (>EUR 750M consolidated revenue — effective 2025)
• PDPA data privacy compliance — fines up to THB 5M admin + THB 1M criminal
• Strict labour dismissal rules: requires just cause + severance payment
• Transfer pricing documentation required (Master File, Local File, CbCR for large groups)
• Lese-Majeste laws strictly enforced — cultural awareness critical
 
COMPLIANCE PENALTIES (Thailand):
• FBA Nominee Shareholding: imprisonment up to 3 years + THB 100K-1M fine + company dissolution
• FBA operation without licence: imprisonment up to 3 years + THB 100K-1M + THB 10K-50K daily fine
• Annual Accounts late/failure: director fines up to THB 50,000 each
• CIT Return (PND.50) late filing: THB 1,000-2,000 fine + 1.5% monthly interest on unpaid tax
• VAT PP.30 late filing: THB 2,000 per return + 1.5% monthly interest
• PDPA violation/breach: admin fines up to THB 5M + criminal THB 1M + compensation to data subjects
• Social Security non-payment: 2% monthly surcharge + up to 200% penalty
• Work Permit violation (foreign employee without WP): THB 50K-100K fine + employer fines + deportation
• BOI Conditions non-compliance: withdrawal of all benefits + retrospective tax collection
 
SPECIAL ECONOMIC ZONES (Thailand):
• EEC (Eastern Economic Corridor) — Chonburi, Rayong, Chachoengsao: flagship zone for S-Curve industries (EV, smart electronics, advanced tourism, robotics, aviation, digital, medical hub). Enhanced BOI: 13-year CIT exemption + 50% reduction 5 more years; 17% flat PIT for target industry experts; streamlined work permits/visas.
• Border SEZs (10 zones along Thai borders): 10% CIT rate for targeted businesses for 10 consecutive periods (approved 2025)
• 70+ Industrial Estates: operated by IEAT and private operators (Amata, WHA, Hemaraj) — plug-and-play infrastructure for BOI-promoted manufacturers
 
DATA PROTECTION (Thailand):
• Personal Data Protection Act (PDPA) B.E. 2562 — in full effect since 1 June 2022; closely mirrors EU GDPR
• Lawful basis required for processing; transparent privacy notices; data subject rights (access, rectification, erasure, portability, objection, restriction)
• Breach notification to PDPC within 72 hours
• DPO required for public authorities, large-scale regular monitoring, or large-scale special categories
• Cross-border transfers: adequacy or appropriate safeguards (SCCs, BCRs) required
• Max penalties: THB 5M administrative + THB 1M criminal + compensation liability

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — ESTONIA (Entry Estonia Guide 2026 — e-Residency & EU Gateway)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT (Estonia 2026):
• Population: ~1.37 million; EU/EEA/Eurozone/NATO/OECD member
• Capital: Tallinn; also Tartu (university/R&D hub)
• Currency: Euro (EUR); Schengen Area member
• Famous startups: Skype, Wise, Bolt, Pipedrive, Veriff, Playtech
• India-Estonia DTAA: in force since June 20, 2012; dividends/interest/royalties/FTS all capped at 10%
• e-Residency program: 140,000+ e-residents from 180+ countries; India among active markets

WHY ESTONIA / e-RESIDENCY FOR INDIAN BUSINESSES:
• UNIQUE: 0% corporate income tax on RETAINED/REINVESTED profits — only pay 22/78 when you distribute
• 100% online company formation via e-Residency (no physical presence in Estonia required)
• Full EU company status — sell across EU/EEA, access SEPA payments, EU VAT OSS, EU funding programs
• EU trademark (EUTM) and IP protection via EUIPO covering all 27 EU member states
• English-friendly administration; strong startup ecosystem
• Low ongoing compliance cost: ~EUR 100-300/month for service provider (accounting + registered address)
• Ideal for: Indian SaaS companies, IT services exporters, freelancers, consultants, digital businesses

e-RESIDENCY — WHAT IT IS AND IS NOT:
• e-Residency IS: a government-issued digital identity (EUR 150 fee in 2026); allows online company registration, digital document signing under eIDAS, access to e-Tax Board and e-Business Register
• e-Residency is NOT: citizenship, physical residency, a visa, or a travel document
• e-Residency does NOT grant: right to live/work in Estonia/EU, tax residency in Estonia, Schengen access
• YOUR Estonian OÜ is an Estonian tax-resident entity; YOU remain an Indian tax resident on worldwide income
• This distinction is CRITICAL for FEMA ODI compliance on the Indian side

e-RESIDENCY APPLICATION PROCESS:
1. Apply online at e-resident.gov.ee (EUR 150 state fee; passport, photo, motivation statement) — 30 minutes
2. Background check by Estonian Police and Border Guard Board — 3-8 weeks
3. Collect e-Residency kit at an official pickup point (Estonian embassy/consulate or approved location)
4. Install ID card software; use digital services immediately

INCORPORATION (Estonian OÜ via e-Residency):
• OÜ (Osaühing) = Private Limited Company — the recommended entity type for all e-residents
• Minimum share capital: EUR 0.01 per shareholder (founders remain liable for unpaid portion if below EUR 2,500)
• Minimum 1 shareholder (any nationality); minimum 1 management board member (any nationality, no residency required)
• Mandatory for e-resident companies: legal address + licensed contact person in Estonia (service provider)
• State registration fee: EUR 265 for electronic incorporation via e-Business Register
• Typical total setup cost: EUR 500-2,000 (state fees + service provider + virtual office)
• Timeline: OÜ registration — a few hours to a few business days once e-Residency card obtained
• Service providers: Xolo, 1Office, Enty, Companio and others from the e-Residency Marketplace

OTHER STRUCTURES (less common for e-residents):
• AS (Aktsiaselts / Public Limited Company): min EUR 25,000 capital; supervisory board required; for listing
• Branch Office: extension of Indian parent; requires registration; less common
• FIE (Sole Proprietor): no limited liability; not suitable for foreign entrepreneurs

TAXATION — ESTONIA'S UNIQUE DISTRIBUTION-BASED SYSTEM:
Tax Category                          | Rate          | Notes
CIT on retained/reinvested profits    | 0%            | NO annual corporate income tax on undistributed profits
CIT on distributed profits            | 22/78 of net  | Standard rate from 1 Jan 2025 (lower 14/86 abolished)
Income tax on salaries/board fees     | 22%           | Withheld from employment and board member remuneration
VAT (standard)                        | 24%           | From 1 July 2025
VAT (reduced)                         | 9%            | Applies to certain goods/services under VAT Act
Social tax (employer)                 | 33%           | On gross salary/remuneration
Unemployment insurance                | 1.6% employee + 0.8% employer | On gross salary
WHT on dividends to non-residents     | 0%            | Company-level CIT (22/78) already paid; NO additional WHT
WHT on interest to non-residents      | 0%            | No Estonian WHT on interest payments
WHT on royalties to non-residents     | 10%           | Treaty relief may apply (DTAA caps at 10%)
Capital gains on shares               | Generally exempt | Participation exemption may apply

WHY THE 0% CIT MATTERS FOR INDIAN GROWTH COMPANIES:
• Profits can stay in the company reinvested tax-free until you decide to distribute
• When you do distribute: 22% CIT paid by the company → remaining 78% flows to Indian parent
• No additional Estonian WHT on dividends (CIT was already paid at company level)
• Indian parent includes dividend in taxable income → claims Foreign Tax Credit under Section 90/Rule 128
• Compared to most jurisdictions taxing profits annually, Estonia improves cash available for reinvestment

INDIA-ESTONIA DTAA RATES (in force June 2012):
Payment Type         | Estonian Domestic | India-Estonia DTAA Rate
Dividends            | 0% WHT            | 10% (moot — no separate dividend WHT; CIT paid at company level)
Interest             | 0% (no Estonian WHT) | 10% cap
Royalties            | 10%               | 10%
Fees for Tech Svcs   | 10%               | 10%
Capital gains        | Generally exempt  | Per DTAA provisions

EU GATEWAY BENEFITS (Estonian OÜ = full EU company):
• EU Single Market Access: sell across EU/EEA without separate incorporation in each country
• SEPA Payments: send/receive EUR across 36 countries at domestic rates
• EU VAT OSS (One-Stop Shop): file and pay VAT on cross-border B2C digital/distance sales across all EU via single Estonian filing — massively simplifies EU-wide VAT compliance
• EU GDPR: operate under EU data protection framework — credibility with European customers
• EU IP (EUTM, RCD via EUIPO): EU-wide trademark/design protection through single filing
• EU Funding: eligible for Horizon Europe, EIC, COSME/SMP, structural funds
• Enhanced credibility vs invoicing from an Indian entity

ESTONIA vs OTHER EU ENTRY POINTS:
Feature              | Estonia     | Netherlands | Ireland     | Germany
CIT on retained     | 0%          | Annual tax  | Annual tax  | Annual tax
Remote formation    | 100% online | Often local | Usually online | Often local steps
e-Residency         | Yes         | No          | No          | No
Minimum capital     | EUR 0.01    | Varies      | Varies      | EUR 25,000 (GmbH)
Compliance cost     | Low         | Medium      | Medium      | High

BANKING FOR e-RESIDENT COMPANIES:
• Traditional Estonian banks may require stronger local substance or in-person steps
• Practical alternatives: Wise Business, Revolut Business, Payoneer, Stripe, PayPal (EMI/payment accounts; SEPA transfers, multi-currency, accounting integrations)
• For larger companies needing full banking: local bank onboarding possible depending on profile

EMPLOYMENT IN ESTONIA:
• Standard 40-hour work week; minimum wage EUR 946/month from 1 April 2026
• 28 calendar days paid annual leave
• Employer costs above gross salary: Social tax 33% + Unemployment insurance 0.8%
• Employer total burden significantly above gross pay — plan accordingly
• e-Residency alone does NOT grant the right to physically work in Estonia

IMMIGRATION FOR PHYSICAL PRESENCE (if needed):
• Startup Visa: for innovative startup founders; 1 year initially → up to 5 years temp residence
• Employment-based temp residence permit: sponsored by Estonian employer
• Digital Nomad Visa (DNV): for remote workers employed by non-Estonian companies; up to 1 year
• ICT Directive: intra-corporate transfer from non-EU parent
• EU Blue Card: for highly qualified workers meeting salary thresholds
• Most Indian e-resident entrepreneurs managing OÜ remotely from India need NO Estonian visa/permit

COMPLIANCE CALENDAR (Estonia):
• Monthly (10th): TSD declaration (social tax, income tax on salaries/board fees) — ONLY if company has employees/board fees. TSD Annex 7 (CIT on distributions) — ONLY if distribution occurred that month.
• Monthly (20th): VAT return (if VAT-registered)
• Employment Register: update before employee start date (real-time registration required)
• Annual (June 30 for Dec 31 FY): Annual Report (financial statements) filing via e-Business Register
• Annual: Beneficial ownership (UBO) update within 30 days of any change
• Indian parent: Form FC / APR / FLA Return per FEMA timelines

KEY SIMPLIFICATION: No annual CIT return to file (unlike virtually every other jurisdiction) — CIT is only declared/paid in months when distributions or non-business expenses occur.

VAT REGISTRATION: Mandatory if taxable turnover exceeds EUR 40,000; voluntary registration possible below threshold.

COMPLIANCE PENALTIES (Estonia):
• Annual Report non-filing (2+ years): compulsory dissolution warning; eventual strike-off
• CIT on distributions late: 0.06% daily interest on unpaid tax
• TSD late filing: EUR fine + interest; penalty up to EUR 3,200
• VAT late filing/payment: 0.06% daily interest; penalties for fraud
• AML non-compliance: service provider may resign; company may face dissolution
• Transfer pricing non-arm's length: deemed distribution — 22/78 CIT + interest + penalties
• Employment Register unregistered employee: fine up to EUR 3,200 per violation
• GDPR breach: up to EUR 20M or 4% of global turnover (EU-wide)
• No service provider (for e-resident company): warning → potential dissolution

KEY RISKS FOR INDIAN BUSINESSES IN ESTONIA:
• Substance requirements: Estonian tax authorities may challenge companies with no genuine economic activity; ensure real business decisions are made through Estonian entity
• e-Residency ≠ tax residency: personal income remains taxable in India; OÜ is Estonian tax-resident but you are not
• Transfer pricing: arm's length principle applies to transactions between OÜ and Indian parent
• AML compliance: Estonia has tightened AML significantly; service providers perform ongoing due diligence
• FEMA ODI compliance must be handled properly on the Indian side before first remittance

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — ITALY (Entry Italy Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT (Italy 2026):
• Population: ~59 million; EU/Eurozone/G7/G20/OECD founding member
• Currency: Euro (EUR); GDP: one of Europe's largest economies
• Key hubs: Milan (financial/commercial hub), Rome (political centre), Turin (manufacturing/automotive), Bologna (logistics/industrial engineering), Naples (southern access/services)
• Legal system: Civil law
• Italy has an income tax treaty with India reducing double taxation risk
• Indian business community active in trade, textiles, IT services, manufacturing, food distribution

WHY ITALY FOR INDIAN BUSINESSES:
• Gateway to EU single market (4th-largest EU economy)
• World-class industrial base: machinery, automotive components, agri-food, pharma, luxury/fashion, life sciences
• 100% foreign ownership permitted in most sectors
• India-Italy DTAA in force — reduces withholding risk on cross-border payments
• Strong infrastructure, skilled workforce, and mature banking/legal ecosystem
• Access to EU trade agreements, EU funding programs, and SEPA payment zone

ENTRY TIMELINES (Italy):
• S.r.l. incorporation: 1-3 weeks once documents are ready
• Bank account opening + tax/social security registrations: overall setup 3-8 weeks
• Professional setup costs: EUR 2,000-8,000 plus share capital, notarial fees, and local filing costs
• Sector-specific authorizations can add time

BUSINESS STRUCTURES:
Structure              | Min Capital | Tax Treatment          | Notes
S.r.l. (Subsidiary)   | EUR 10,000  | IRES 24% + IRAP ~3.9%  | Most common; best for most Indian investors
S.r.l.s (simplified)  | EUR 1+      | IRES 24% + IRAP ~3.9%  | Simplified S.r.l.; restrictions apply
Branch (sede secondaria)| No fixed min| Italian tax on PE profits| Parent fully liable; lighter setup
Rep. Office            | N/A         | Non-revenue              | Liaison only; no CIT
S.p.A.                 | EUR 50,000  | IRES 24% + IRAP ~3.9%  | Larger/regulated businesses; stock listing

KEY POINT: S.r.l. is the preferred and most common vehicle for Indian businesses — flexible, credible with banks, suits trading, services, and operating companies.

FOREIGN INVESTMENT RULES:
• No general foreign ownership cap for ordinary commercial companies
• 100% foreign ownership allowed in non-restricted sectors
• Golden Power screening: mandatory notification/approval for strategic sector acquisitions (defence, energy, communications, transport, 5G, cloud, semiconductors, national security)
• No exchange controls on normal commercial flows (EU member)

TAXATION (Italy 2026):
Tax                    | Rate           | Notes
IRES (Corporate CIT)   | 24%            | Standard corporate income tax on company profits
IRAP (Regional Tax)    | Generally 3.9% | Regional production tax; rate varies by region and sector
Pillar Two             | 15% minimum    | For large multinational groups (>EUR 750M revenue)
Standard VAT           | 22%            | Reduced rates: 10%, 5%, 4% for specific goods/services
Effective combined     | ~27.9%         | IRES 24% + IRAP 3.9% (varies by sector/region)

WITHHOLDING TAX RATES (Italy):
Payment Type        | Domestic Rate    | Treaty Relief (India-Italy)
Dividends           | 26% domestic WHT | May be reduced under India-Italy DTAA + participation conditions
Interest            | Rate depends on instrument | Treaty relief may apply
Royalties           | Generally WHT applies | Treaty relief may apply
Independent services| Often no domestic WHT unless specific rules | Treaty + PE analysis needed

TAX INCENTIVES (Italy):
• Investment tax credits for capital goods and digital/green transition projects (subject to annual laws)
• Patent Box-style incentives for qualifying IP income (where available under current regime)
• Regional incentives and grants — especially southern Italy (Mezzogiorno) and designated development zones
• R&D, innovation, training, and energy-efficiency support measures
• SEZ (Special Economic Zones) in southern Italy and certain port/industrial areas

INCORPORATION PROCESS (Italy):
1. Obtain tax code (codice fiscale) for shareholders/directors (1-5 days; Agenzia delle Entrate)
2. Prepare deed of incorporation and by-laws (2-5 days; notary/counsel)
3. Execute notarial deed (same day; Italian notary — mandatory)
4. File with Registro delle Imprese / Camera di Commercio (1-3 days)
5. Obtain VAT number and company registrations (1-2 weeks; Agenzia delle Entrate)
6. Register with INPS and INAIL if hiring (1-2 weeks)
7. Open bank account (2-8 weeks; Italian bank)
8. Obtain sectoral licences if needed (varies)

IMPORTANT SETUP REQUIREMENTS:
• Codice fiscale (Italian tax code): required for shareholders, directors, beneficial owners
• PEC (Certified email / Posta Elettronica Certificata): mandatory for all registered companies
• Digital signature: required for many official filings
• Registered office (sede legale): physical address in Italy required
• Foreign corporate shareholders: need apostilled incorporation documents + board resolutions + certified Italian translations

KEY REGULATORY BODIES (Italy):
• Registro delle Imprese / Camera di Commercio: company registration and filings
• Agenzia delle Entrate: tax registration and tax administration
• MIMIT (Ministero delle Imprese e del Made in Italy): industrial policy and incentives
• Bank of Italy / CONSOB: financial and capital markets oversight
• Garante (Data Protection Authority): GDPR enforcement
• INPS: social security; INAIL: workplace accident insurance
• AGCM: competition oversight

EMPLOYMENT & PAYROLL (Italy):
• 40-hour standard work week
• Employment governed by Civil Code + statutory labour rules + CCNLs (sectoral collective bargaining agreements — binding and vary by industry)
• Minimum paid annual leave, sick leave, maternity/paternity protection, notice periods, mandatory workplace safety
• Payroll: IRPEF withholding, INPS contributions, INAIL insurance, payslips, annual employee tax certificates (Certificazione Unica)
• Employer INPS contributions are significant — typically 30-35% above gross salary
• CCNLs (Contratti Collettivi Nazionali di Lavoro) are industry-specific agreements that determine minimum pay, benefits, and terms — critical to identify the correct CCNL for your sector

IMMIGRATION FOR INDIAN NATIONALS (Italy):
• Non-EU nationals need correct visa and residence/work permit to work in Italy
• Work visa tied to employer sponsorship (Decreto Flussi — annual quota system; apply when quotas open)
• Intra-company transfer route: for managers/specialists from Indian parent
• EU Blue Card: for highly qualified workers meeting salary thresholds
• Italy Startup Visa: for innovative startup founders (no quota requirement)
• Researcher/self-employed visa: for specific roles

BANKING (Italy):
• Major Italian banks: Intesa Sanpaolo, UniCredit, Banco BPM, Banca MPS, BPER Banca
• Foreign-owned structures face enhanced KYC/due diligence — allow 2-8 weeks
• Required: incorporation docs, tax codes, proof of registered office, UBO documentation, board resolutions, business plans
• Digital fintech options (Qonto, N26 Business) faster than traditional banks

DATA PROTECTION (Italy):
• EU GDPR applies directly + Italy's national Privacy Code (Codice Privacy)
• Garante per la Protezione dei Dati Personali is the supervisory authority
• Key obligations: lawful processing, transparency notices, processor contracts, breach management, DPIAs where necessary
• Max GDPR fines: up to EUR 20M or 4% of global annual turnover (higher of two)

COMPLIANCE CALENDAR (Italy — Key Dates):
• Monthly (around 16th): VAT, IRPEF withholding, INPS contributions settlement via F24 payment system
• Mar 16: Certificazione Unica (annual tax certificate) issued to employees and contractors
• Apr 30: Annual VAT return filing; prepare financial statements and tax computations
• Jun 16: First IRES/IRAP advance payments; monthly settlement
• Sep 30: Corporate tax return (Modello Redditi SC / IRAP) for calendar-year companies
• Oct 31: Annual withholding return (Form 770)
• Nov 30: Second IRES/IRAP advance payments

COMPLIANCE PENALTIES (Italy):
• VAT late filing/payment: interest, penalties, administrative charges (Agenzia delle Entrate)
• Corporate tax late/incorrect return: penalties and interest
• Payroll withholding/INPS late remittance: surcharges, interest, sanctions
• Financial statements late filing: administrative fines and filing defaults (Registro delle Imprese)
• GDPR serious breach: significant administrative fines (Garante)
• Golden Power failure to notify where required: transaction risk, sanctions, remedial measures

KEY RISKS FOR INDIAN BUSINESSES IN ITALY:
• Golden Power screening in strategic sectors (mandatory — failure to notify has serious consequences)
• Bank onboarding enhanced KYC for foreign-owned structures (allow extra time)
• CCNL employment compliance — must identify correct sectoral agreement for each employee category
• Transfer pricing and permanent establishment risk for Indian parent companies
• Regional and municipal permitting differences for industrial projects
• Italian language: contracts, company filings, and official communications typically in Italian

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — INDONESIA (Entry Indonesia Guide 2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COUNTRY SNAPSHOT (Indonesia 2026):
• GDP: ~USD 1.4 trillion (2025); Southeast Asia's LARGEST economy; world's 4th most populous country (280M+)
• Currency: Indonesian Rupiah (IDR); GDP growth ~5% annually
• Population: 280M+; median age ~30 years; world's largest Muslim-majority nation
• Key hubs: Jakarta/Jabodetabek (35M metro — primary business hub), Surabaya (industrial), Bali (tourism/digital hub), Batam (FTZ near Singapore), Bandung (tech/creative), Semarang, Makassar, Medan
• New capital Nusantara (IKN) under development in East Kalimantan
• Indian diaspora: ~120,000+; strong linkages in textiles, commodities, tech
• India-Indonesia DTAA: signed 1987 (with subsequent protocols); provides reduced WHT on dividends, interest, royalties
• ASEAN member; RCEP in force; ASEAN-India FTA (AIFTA) in force; India-Indonesia CECA under negotiation

WHY INDONESIA FOR INDIAN BUSINESSES:
• Southeast Asia's largest economy — 280M+ people, rapidly growing middle class (100M+)
• One of the world's fastest-growing digital economies (5 unicorns including GoTo, Tokopedia/TikTok Shop)
• Omnibus Law reforms (2020/2023) significantly simplified business registration and liberalized FDI
• Massive tax incentives: Tax Holidays up to 20 years (pioneer industries); Tax Allowance; Super Deductions
• Strategic ASEAN location; abundant natural resources (nickel, coal, palm oil)
• Global hub for nickel processing, EV battery supply chains, green economy
• Government target: top-5 global economy by 2030 (Golden Indonesia 2045 vision)

STANDARD STRUCTURE FOR FOREIGN INVESTORS: PT PMA
• PT PMA (Perseroan Terbatas Penanaman Modal Asing) = foreign-owned limited liability company
• The ONLY viable structure for foreign businesses conducting revenue-generating activities
• Minimum investment plan: IDR 10 billion per business line (KBLI code) — excluding land and buildings (~USD 625,000)
• Minimum paid-up capital: IDR 2.5 billion (~USD 156,000)
• Minimum 2 shareholders (individuals or companies, any nationality)
• No Indonesian director requirement but at least 1 director must reside in Indonesia (practical requirement)
• Commissioner required (minimum 1) — supervisory function

BUSINESS STRUCTURE COMPARISON:
Structure              | Foreign Ownership | Min Investment        | Tax          | Notes
PT PMA (100% foreign)  | Up to 100% (sector-dependent) | IDR 10B + IDR 2.5B paid-up | CIT 22% | Standard for foreign investors
PT PMA (Joint Venture) | Shared            | IDR 10B + IDR 2.5B   | CIT 22%      | For restricted sectors/local market
Rep. Office (KPPA)     | N/A (parent)      | Allocated by parent  | None (no revenue) | Liaison/market research only
Branch Office          | N/A (parent)      | Varies by sector     | CIT 22% + 20% BPT | Banking, O&G, construction only

POSITIVE INVESTMENT LIST (KEY FDI RULE):
• Replaced old Negative Investment List (DNI) — now sectors are OPEN by default unless restricted
• Identified by KBLI code (Indonesian Standard Classification of Business Activities)
• Most sectors open to 100% foreign ownership after Omnibus Law reforms
• Still restricted: media/broadcasting, certain agribusiness, defence, some public services
• ALWAYS check current KBLI classification for your specific business activity before planning

CORPORATE INCOME TAX (Indonesia 2026):
Category                       | Rate         | Notes
Standard CIT (PPh Badan)       | 22%          | All resident companies and PEs
Listed company discount        | 19% (3pp off)| Companies listing 40%+ shares on IDX and meeting conditions
SME rate                       | 11% effective| 50% CIT reduction on income up to IDR 4.8B for revenue <IDR 50B
MSME Final Tax                 | 0.5% turnover| For MSMEs with annual turnover <IDR 4.8B (time-limited 3-4 years)
Tax Holiday (Pioneer Industry) | 100% CIT exempt| 5-20 years; IDR 100B-30T+ investment; extendable to 25 years
Tax Allowance                  | 30% reduction| Over 6 years for priority sector qualifying investments
Branch Profit Tax (PPh 26)     | 20% (treaty 10-15%)| On after-tax profits remitted by foreign company branches

VAT (Indonesia 2026):
• Official rate: 12% from 1 January 2025 (Harmonised Tax Law)
• IMPORTANT: for most goods/services, effective rate is approximately 11% through transitional calculation mechanisms
• VAT registration (PKP status): mandatory when annual turnover exceeds IDR 4.8 billion
• Monthly VAT returns (SPT Masa PPN) due by end of following month
• E-invoicing (e-Faktur): mandatory for all VAT-able transactions
• Export of goods: zero-rated (0%)
• VAT-exempt: basic necessities, healthcare, education, financial services
• Luxury Goods Sales Tax (PPnBM): 10%-200% on luxury items

WITHHOLDING TAX — INDIA-INDONESIA DTAA:
Payment Type                  | Indonesian Domestic | India-Indonesia DTAA
Dividends to non-residents    | 20% (PPh 26)        | 10% for 25%+ holding; 15% otherwise
Interest to non-residents     | 20% (PPh 26)        | 10%
Royalties (equipment)         | 20% (PPh 26)        | 10%
Royalties (other)             | 20% (PPh 26)        | 15%
Service fees to non-residents | 20% (PPh 26)        | PE/business profits article applies
Branch Profit Tax             | 20% (PPh 26)        | 10-15% under DTAA

TAX INCENTIVES (Indonesia — Very Important):
• Tax Holiday: 100% CIT exemption for 5-20 years for Pioneer Industries with minimum IDR 100 billion investment; extendable to 25 years for mega-investments (IDR 30 trillion+). Pioneer industries include: basic metals, oil refining, petrochemicals, machinery, robotics, pharmaceuticals, telecoms, maritime, agriculture, digital economy infrastructure
• Tax Allowance: 30% of investment value deductible over 6 years (5% per year) + accelerated depreciation + loss carry-forward up to 10 years + reduced 10% WHT on dividends for qualifying investments in priority sectors/areas
• Super Deduction: up to 300% for R&D activities; 200% for vocational/competency training; 200% for apprenticeships
• SEZ Incentives: income tax facilities (reduction/exemption), VAT and import duty exemptions for businesses in Special Economic Zones (KEK)
• Free Trade Zones (FTZ): Batam, Bintan, Karimun — VAT and import duty exemptions for manufacturing/logistics
• IKN (New Capital Nusantara): additional tax incentives for investors in the new capital city

INCORPORATION PROCESS (Indonesia — PT PMA):
1. KBLI code identification + Positive Investment List check (before anything else)
2. Name reservation via AHU Online (1-3 days; Kemenkumham)
3. Notary drafts Deed of Establishment and Articles (3-7 days; Indonesian notary — mandatory)
4. Legal Entity Approval (SK Pengesahan) from Kemenkumham (3-7 days)
5. Register on OSS-RBA for Business Identification Number (NIB) (1-3 days)
6. Obtain risk-based business licences via OSS-RBA (1-4 weeks depending on risk class)
7. Register for Tax ID (NPWP) via Coretax system (1-2 weeks)
8. Register as VAT-able entrepreneur (PKP) if applicable (1-2 weeks)
9. Open Indonesian corporate bank account (4-8 weeks — LONGEST STEP)
10. Deposit paid-up capital (min IDR 2.5B) into company account
11. Apply for RPTKA + ITAS for foreign workers (4-8 weeks)
12. Register with BPJS Ketenagakerjaan and BPJS Kesehatan (before first payroll)
TOTAL TIMELINE: 4-8 weeks for registration; 8-16 weeks for full operational setup

KEY REGULATORY BODIES (Indonesia):
• Ministry of Investment / BKPM: investment coordination and licensing via OSS-RBA
• Kemenkumham (Ministry of Law and Human Rights): company registration and legal entity approval
• DJP/DGT (Directorate General of Taxes): tax administration via new Coretax system
• Bank Indonesia (BI): central bank, monetary policy, foreign exchange regulation
• OJK (Otoritas Jasa Keuangan): financial services authority
• Ministry of Manpower: labour regulations and foreign worker permits (RPTKA/ITAS)
• BPOM: food and drug administration; Komdigi: telecoms and digital

EMPLOYMENT & PAYROLL (Indonesia):
• Standard 40-hour work week (8 hrs/day 5 days, or 7 hrs/day 6 days)
• Minimum wage set by provincial/city government annually (Jakarta 2025: ~IDR 5.4M/month)
• THR (Tunjangan Hari Raya): mandatory religious holiday allowance = 1 month salary (paid before Eid)
• Severance pay: 1-9 months salary based on tenure (Omnibus Law reduced maximums)
• Minimum 12 days annual leave after 12 months
• Maternity leave: 3 months (paid); Paternity leave: 2 days (paid)
• BPJS Ketenagakerjaan (employer 5.74-11.74%): JKK (work accident), JKM (death), JHT (old age), JP (pension), JKP (job loss)
• BPJS Kesehatan (health): employer 4%, employee 1% of salary (capped)
• Monthly PPh 21 deposit by 15th, file by 20th of following month via Coretax
• 4:1 Indonesian-to-foreign employee ratio generally applies (1:1 in some sectors) + knowledge transfer requirement

IMMIGRATION FOR INDIAN NATIONALS (Indonesia):
• ITAS (Limited Stay Permit) + RPTKA (Foreign Worker Utilisation Plan): standard work permit route
  - RPTKA approval required before ITAS; DKP-TKA fee USD 1,200/foreign worker/year
  - Maximum 2-year initial period, renewable
• Investor KITAS: for shareholders/investors in PT PMA meeting minimum investment thresholds
• Director KITAS: for appointed directors of Indonesian companies
• B211A Business Visa: short-term business visits (60 days, extendable)
• Second Home Visa: 5-10 years for individuals meeting financial criteria
• ITAP (Permanent Stay Permit): after 3+ consecutive years on ITAS

BANKING (Indonesia):
• Typical time for PT PMA: 4-8 weeks — often the LONGEST step
• Physical presence of directors usually required at bank branch
• Required: Deed of Establishment, SK Pengesahan, NIB, NPWP, domicile letter (SKDP), board resolution, passport copies + KITAS/ITAS for foreign directors, proof of registered office, company profile/business plan
• Major banks: Bank Mandiri, Bank BRI, Bank BNI, Bank BCA, Bank CIMB Niaga
• International banks: HSBC, Standard Chartered, DBS also serve PT PMAs

FOREIGN EXCHANGE RULES (Indonesia):
• DHE (Devisa Hasil Ekspor) requirement: export proceeds must be deposited in Indonesian banks for 3 months — mandatory
• Foreign currency transactions >USD 25,000/month require supporting documentation
• Dividends, profits, capital: can be repatriated freely in foreign currency subject to WHT and documentation
• All domestic transactions generally settled in Rupiah (BI Regulation; limited exceptions for international trade)

COMPLIANCE CALENDAR (Indonesia — Key Dates):
• Monthly (15th): PPh 21/23/25/4(2) deposits; BPJS contributions
• Monthly (20th): SPT Masa PPh filings (PPh 21/23/26)
• Monthly (end of month): VAT Return (SPT Masa PPN) + e-Faktur
• Jan 30: Annual LKPM (Investment Activity Report) to BKPM
• Jan 31: Form 1721-A1 to employees (annual tax certificate for prior year); VAT return for December
• Mar 31: Individual PIT returns (SPT Tahunan PPh OP)
• Apr 10: Quarterly LKPM for Q1
• Apr 30: Annual CIT Return (SPT Tahunan PPh Badan) for prior fiscal year
• Jun 30: AGM deadline (within 6 months of December FY end)
• Jul 10, Oct 10: Quarterly LKPM for Q2 and Q3
• Dec 31: Indonesian tax year end; THR payment before Eid al-Fitr (religious holiday allowance)

COMPLIANCE PENALTIES (Indonesia):
• Annual CIT Return late: 2% monthly penalty on underpaid tax; administrative penalties
• VAT return late/underpaid: 2% monthly penalty + potential audit
• PPh 21 (payroll WHT) non-compliance: 2% monthly surcharge + potential criminal liability
• Transfer pricing non-arm's length: adjustment + significant penalties + interest
• RPTKA/ITAS violations (foreign worker without permit): IDR 10-100M fine + deportation
• PDP Law (data privacy) violations: fines up to 2% of annual revenue; criminal penalties up to 6 years + IDR 6B fine
• Anti-nominee provisions: nominee arrangements are VOID under Company Law; serious legal risk
• Late LKPM investment reports: potential suspension of OSS business licence

KEY RISKS FOR INDIAN BUSINESSES IN INDONESIA:
• IDR 10 billion minimum investment plan per KBLI: significant capital commitment — plan carefully
• KBLI code selection: wrong code = wrong licence = compliance problems; identify correctly before registration
• Anti-nominee rules strictly enforced: nominee shareholder arrangements are void under Indonesian Company Law
• Indonesian language: contracts involving Indonesian parties technically require Bahasa Indonesia version (prevails in conflict); bilingual contracts are standard practice
• Land ownership: foreign individuals and PT PMAs cannot own freehold land (Hak Milik); PT PMAs can hold HGB (Hak Guna Bangunan) for 30+20+30 years
• DHE export proceeds holding requirement (3 months in Indonesian banks)
• Coretax system (CTAS from January 2025): teething issues expected in first year of implementation
• Transfer pricing enforcement: DGT (tax authority) is increasingly sophisticated
• Labour law: severance obligations still significant despite Omnibus Law changes; TCO required for foreign workers

SPECIAL ECONOMIC ZONES AND STRATEGIC AREAS (Indonesia):
• KEK (Kawasan Ekonomi Khusus / Special Economic Zones): 19 designated KEKs with income tax facilities, VAT/import duty exemptions, simplified licensing. Notable: Sei Mangkei (palm oil), Mandalika (tourism), Galang Batang (industrial)
• FTZ (Free Trade Zones): Batam, Bintan, Karimun — VAT and import duty exemptions for manufacturing and logistics (near Singapore — very strategic)
• Industrial Estates: Cikarang (EJIP, Jababeka), Bekasi, Karawang (West Java); SIER Surabaya; estates in Kalimantan and Sulawesi
• IKN (Nusantara — new capital): pioneering investment with special tax holidays, super deductions, simplified licensing in East Kalimantan
• Bonded Zones (Kawasan Berikat): for manufacturing/export-oriented companies with customs facilities

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
