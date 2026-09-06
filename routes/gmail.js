const express = require('express');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const pool = require('../db/pool');

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

function parseNumber(raw) {
  const value = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
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
      const numMatch =
        afterWindow.match(/[\d,]+\.\d{2}|[\d,]{2,}/) ||
        beforeWindow.match(/[\d,]+\.\d{2}|[\d,]{2,}/);
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
  const last = matches[matches.length - 1];
  return parseNumber(last[1] || last[2]);
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

  let inserted = 0;
  for (const ref of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
    const headers = Object.fromEntries(
      msg.data.payload.headers.map((h) => [h.name, h.value])
    );
    const subject = headers.Subject || '(no subject)';
    const sender = (headers.From || 'unknown').split('<')[0].trim();
    const dateHeader = headers.Date ? new Date(headers.Date) : new Date();

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

    try {
      const result = await pool.query(
        `INSERT INTO transactions (date, type, amount, category, note, vat_eligible, source, external_id)
         VALUES ($1, 'expense', $2, $3, $4, TRUE, 'gmail', $5)
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET amount = EXCLUDED.amount
         WHERE transactions.amount = 0 AND EXCLUDED.amount != 0
         RETURNING id, (xmax = 0) AS inserted`,
        [dateHeader.toISOString().slice(0, 10), amount || 0, sender, subject, ref.id]
      );
      if (result.rowCount) inserted += 1;
    } catch (e) {
      console.error('Failed to insert message', ref.id, e);
    }
  }

  return { scanned: messages.length, inserted };
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
      `Scanned ${result.scanned} emails, added ${result.inserted} new transactions. ` +
      `You can close this tab and check /api/transactions.`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(`Sync failed: ${err.message}`);
  }
});

module.exports = { router, syncGmail };
