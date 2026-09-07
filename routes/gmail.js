const express = require('express');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const pool = require('../db/pool');
const { classifyTransaction } = require('../utils/classify');

const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const SEARCH_QUERY =
  '(subject:חשבונית OR subject:קבלה OR subject:invoice OR subject:receipt ' +
  'OR subject:"אישור תשלום" OR subject:"אישור חיוב")';

const AMOUNT_PATTERN = /(?:₪|ILS|NIS|\$|USD)\s?([\d,]+\.?\d{0,2})|([\d,]+\.?\d{0,2})\s?(?:₪|ILS|NIS)/g;

const TOTAL_KEYWORDS = [
  'סה"כ לתשלום', 'סך הכל לתשלום', 'סה"כ לתשלום כולל מע"מ',
  'סה"כ', 'סך הכל', 'לתשלום', 'total amount', 'amount due', 'total due', 'grand total', 'total',
];

const MAX_PLAUSIBLE_AMOUNT = 200000;

function parseNumber(raw) {
  const value = parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PLAUSIBLE_AMOUNT) return null;
  return value;
}

const DECIMAL_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b/;
const BARE_DIGITS = /[\d,]{2,}/;

function findAmountInWindow(window) {
  return window.match(DECIMAL_AMOUNT) || window.match(BARE_DIGITS);
}

function extractAmountNearKeywords(text) {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  let best = null;
  for (const keyword of TOTAL_KEYWORDS) {
    const lowerKeyword = keyword.toLowerCase();
    let searchFrom = 0;
    let idx;
    while ((idx = lowerText.indexOf(lowerKeyword, searchFrom)) !== -1) {
      const afterWindow = text.slice(idx + keyword.length, idx + keyword.length + 25);
      const beforeWindow = text.slice(Math.max(0, idx - 25), idx);
      const numMatch = findAmountInWindow(afterWindow) || findAmountInWindow(beforeWindow);
      if (numMatch) {
        const value = parseNumber(numMatch[0]);
        if (value !== null) best = value;
      }
      searchFrom = idx + keyword.length;
    }
  }
  return best;
}

function extractAmountByCurrency(text) {
  if (!text) return null;
  const matches = [...text.matchAll(AMOUNT_PATTERN)];
  if (!matches.length) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = parseNumber(matches[i][1] || matches[i][2]);
    if (value !== null) return value;
  }
  return null;
}

function extractAmount(text) {
  return extractAmountNearKeywords(text) ?? extractAmountByCurrency(text);
}

function decodeBody(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const text = decodeBody(part);
    if (text) return text;
  }
  return '';
}

async function loadRefreshToken() {
  const result = await pool.query(`SELECT refresh_token FROM oauth_tokens WHERE provider = 'gmail'`);
  return result.rows[0]?.refresh_token || null;
}

async function loadExcludedSenders() {
  const result = await pool.query(`SELECT sender FROM excluded_senders`);
  return new Set(result.rows.map((r) => r.sender));
}

router.get('/auth', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI) {
    return res.status(500).send(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI environment variable on the server.'
    );
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
  });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    if (!tokens.refresh_token) {
      return res.status(400).send(
        'No refresh token returned. Revoke access at myaccount.google.com/permissions and try /api/gmail/auth again.'
      );
    }
    await pool.query(
      `INSERT INTO oauth_tokens (provider, refresh_token, updated_at)
       VALUES ('gmail', $1, now())
       ON CONFLICT (provider) DO UPDATE SET refresh_token = $1, updated_at = now()`,
      [tokens.refresh_token]
    );
    res.send('Gmail connected successfully. You can close this tab.');
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth exchange failed -- check server logs.');
  }
});

async function syncGmail(days = 30) {
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) {
    throw new Error('Gmail not connected yet -- visit /api/gmail/auth first.');
  }
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const after = new Date(Date.now() - days * 86400000);
  const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
  const query = `${SEARCH_QUERY} after:${afterStr}`;

  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  const messages = list.data.messages || [];
  const excludedSenders = await loadExcludedSenders();

  let inserted = 0;
  let skipped = 0;
  for (const ref of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
    const headers = Object.fromEntries(
      msg.data.payload.headers.map((h) => [h.name, h.value])
    );
    const subject = headers.Subject || '(no subject)';
    const sender = (headers.From || 'unknown').split('<')[0].trim();
    const dateHeader = headers.Date ? new Date(headers.Date) : new Date();

    if (excludedSenders.has(sender)) {
      skipped += 1;
      continue;
    }

    const body = decodeBody(msg.data.payload);
    let attachmentText = '';
    for (const part of msg.data.payload.parts || []) {
      if (part.filename?.toLowerCase().endsWith('.pdf') && part.body?.attachmentId) {
        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: ref.id,
          id: part.body.attachmentId,
        });
        const buffer = Buffer.from(attachment.data.data, 'base64');
        try {
          const parsed = await pdfParse(buffer);
          attachmentText += parsed.text + '\n';
        } catch (e) { /* skip unparsable PDFs */ }
      }
    }

    const amount = extractAmount(attachmentText) || extractAmount(body) || extractAmount(subject);
    const domainCategory = classifyTransaction({ category: sender, note: subject });

    try {
      const result = await pool.query(
        `INSERT INTO transactions (date, type, amount, category, note, vat_eligible, source, external_id, domain_category)
         VALUES ($1, 'expense', $2, $3, $4, TRUE, 'gmail', $5, $6)
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET amount = EXCLUDED.amount
         WHERE (transactions.amount = 0 OR transactions.amount > 200000) AND EXCLUDED.amount != 0
         RETURNING id, (xmax = 0) AS inserted`,
        [dateHeader.toISOString().slice(0, 10), amount || 0, sender, subject, ref.id, domainCategory]
      );
      if (result.rowCount) inserted += 1;
    } catch (e) {
      console.error('Failed to insert message', ref.id, e);
    }
  }

  return { scanned: messages.length, inserted, skipped };
}

router.post('/sync', async (req, res) => {
  try {
    const days = parseInt(req.body?.days, 10) || 30;
    const result = await syncGmail(days);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync-now', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const result = await syncGmail(days);
    res.send(
      `Scanned ${result.scanned} emails, added ${result.inserted} new transactions, ` +
      `skipped ${result.skipped} from excluded senders. ` +
      `You can close this tab and check /api/transactions.`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(`Sync failed: ${err.message}`);
  }
});

router.get('/exclude-transaction', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!id) return res.status(400).send('Missing or invalid ?id= query parameter.');

  try {
    const txResult = await pool.query(
      `SELECT category, note FROM transactions WHERE id = $1 AND source = 'gmail'`,
      [id]
    );
    if (!txResult.rows.length) {
      return res.status(404).send(`No Gmail-sourced transaction found with id ${id}.`);
    }
    const sender = txResult.rows[0].category;
    if (!sender) {
      return res.status(400).send('This transaction has no sender recorded -- cannot block it.');
    }

    await pool.query(
      `INSERT INTO excluded_senders (sender, reason) VALUES ($1, 'excluded via transaction') ON CONFLICT (sender) DO NOTHING`,
      [sender]
    );
    await pool.query(`DELETE FROM transactions WHERE id = $1`, [id]);

    res.send(
      `Removed transaction #${id} and blocked future emails from "${sender}". ` +
      `You can close this tab.`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to exclude transaction: ${err.message}`);
  }
});

router.get('/excluded-senders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sender, created_at FROM excluded_senders ORDER BY created_at DESC`
    );
    if (!result.rows.length) return res.send('No senders are excluded yet.');
    res.send(result.rows.map((r) => `${r.sender}  (blocked ${r.created_at.toISOString().slice(0, 10)})`).join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to load excluded senders: ${err.message}`);
  }
});

router.get('/unexclude-sender', async (req, res) => {
  const sender = req.query.sender;
  if (!sender) return res.status(400).send('Missing ?sender= query parameter.');
  try {
    await pool.query(`DELETE FROM excluded_senders WHERE sender = $1`, [sender]);
    res.send(`Unblocked "${sender}". Their emails will be picked up on the next sync.`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to unblock sender: ${err.message}`);
  }
});

module.exports = { router, syncGmail };
