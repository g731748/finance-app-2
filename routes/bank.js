const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const pool = require('../db/pool');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const HEADER_HINTS = {
  date: ['תאריך', 'תאריך ערך', 'תאריך פעולה', 'date'],
  description: ['תיאור', 'פרטים', 'תיאור פעולה', 'description', 'details'],
  debit: ['חובה', 'debit'],
  credit: ['זכות', 'credit'],
  amount: ['סכום', 'amount'],
  reference: ['אסמכתא', 'reference', 'מספר אסמכתא'],
};

function normalizeHeader(cell) {
  return String(cell || '').trim().toLowerCase();
}

function findColumnIndex(headerRow, hints) {
  for (let i = 0; i < headerRow.length; i++) {
    const cell = normalizeHeader(headerRow[i]);
    if (hints.some((hint) => cell.includes(hint.toLowerCase()))) return i;
  }
  return -1;
}

function findHeaderRowIndex(rows) {
  const maxScan = Math.min(rows.length, 15);
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i].map(normalizeHeader);
    const hasDate = row.some((c) => HEADER_HINTS.date.some((h) => c.includes(h.toLowerCase())));
    const hasAmount = row.some((c) =>
      [...HEADER_HINTS.debit, ...HEADER_HINTS.credit, ...HEADER_HINTS.amount].some((h) => c.includes(h.toLowerCase()))
    );
    if (hasDate && hasAmount) return i;
  }
  return -1;
}

function parseDate(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(excelEpoch.getTime() + raw * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const str = String(raw).trim();
  let m = str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = str.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function parseAmount(raw) {
  if (raw == null || raw === '') return 0;
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function stripHtmlTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeHtml(buffer) {
  const head = buffer.slice(0, 2000).toString('utf8').toLowerCase();
  return head.includes('<html') || head.includes('<table');
}

function parseHtmlTableRows(html) {
  const rows = [];
  const trMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const trMatch of trMatches) {
    const tdMatches = [...trMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (!tdMatches.length) continue;
    rows.push(tdMatches.map((td) => stripHtmlTags(td[1])));
  }
  return rows;
}

router.get('/import-form', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8"><title>ייבוא קובץ בנק</title>
<style>body{font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px}
h1{font-size:20px}input,button{font-size:15px;padding:8px;margin-top:10px}
button{background:#22314A;color:#fff;border:none;border-radius:4px;cursor:pointer}</style>
</head><body>
<h1>ייבוא קובץ תנועות מהבנק</h1>
<p>בחר קובץ CSV או Excel שהורדת מאתר הבנק (עובר ושב).</p>
<form action="/api/bank/import" method="post" enctype="multipart/form-data">
  <input type="file" name="statement" accept=".csv,.xlsx,.xls" required><br>
  <button type="submit">העלה וייבא</button>
</form>
</body></html>`);
});

router.post('/import', upload.single('statement'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded -- use the "statement" field.');

  try {
    let rows = null;
    let headerRowIndex = -1;

    if (looksLikeHtml(req.file.buffer)) {
      const htmlRows = parseHtmlTableRows(req.file.buffer.toString('utf8'));
      const idx = findHeaderRowIndex(htmlRows);
      if (idx !== -1) {
        rows = htmlRows;
        headerRowIndex = idx;
      }
    }

    if (!rows) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
      for (const sheetName of workbook.SheetNames) {
        const candidateRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
          header: 1, raw: true, defval: '',
        });
        const idx = findHeaderRowIndex(candidateRows);
        if (idx !== -1) {
          rows = candidateRows;
          headerRowIndex = idx;
          break;
        }
      }
    }

    if (!rows || headerRowIndex === -1) {
      return res.status(400).send(
        'Could not find a header row with recognizable date/amount columns in any sheet/table. ' +
        'The file format may not be supported yet -- try exporting as CSV instead of Excel, or vice versa.'
      );
    }

    const headerRow = rows[headerRowIndex];
    const dateCol = findColumnIndex(headerRow, HEADER_HINTS.date);
    const descCol = findColumnIndex(headerRow, HEADER_HINTS.description);
    const debitCol = findColumnIndex(headerRow, HEADER_HINTS.debit);
    const creditCol = findColumnIndex(headerRow, HEADER_HINTS.credit);
    const amountCol = findColumnIndex(headerRow, HEADER_HINTS.amount);
    const refCol = findColumnIndex(headerRow, HEADER_HINTS.reference);

    if (dateCol === -1 || (debitCol === -1 && creditCol === -1 && amountCol === -1)) {
      return res.status(400).send(
        'Found a header row, but could not identify both a date column and an amount column. ' +
        `Header seen: ${JSON.stringify(headerRow)}`
      );
    }

    const dataRows = rows.slice(headerRowIndex + 1);
    let inserted = 0;
    let skipped = 0;

    for (const row of dataRows) {
      const dateRaw = row[dateCol];
      const date = parseDate(dateRaw);
      if (!date) continue;

      const description = descCol !== -1 ? String(row[descCol] || '').trim() : '';
      const reference = refCol !== -1 ? String(row[refCol] || '').trim() : '';

      let type, amount;
      if (debitCol !== -1 || creditCol !== -1) {
        const debit = debitCol !== -1 ? parseAmount(row[debitCol]) : 0;
        const credit = creditCol !== -1 ? parseAmount(row[creditCol]) : 0;
        if (debit > 0) { type = 'expense'; amount = debit; }
        else if (credit > 0) { type = 'income'; amount = credit; }
        else continue;
      } else {
        const raw = parseAmount(row[amountCol]);
        if (raw === 0) continue;
        type = raw < 0 ? 'expense' : 'income';
        amount = Math.abs(raw);
      }

      const fingerprint = crypto
        .createHash('sha1')
        .update(`${date}|${description}|${amount}|${reference}`)
        .digest('hex');

      try {
        const result = await pool.query(
          `INSERT INTO transactions (date, type, amount, category, note, vat_eligible, source, external_id)
           VALUES ($1, $2, $3, '', $4, TRUE, 'bank', $5)
           ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [date, type, amount, description, fingerprint]
        );
        if (result.rowCount) inserted += 1; else skipped += 1;
      } catch (e) {
        console.error('Failed to insert bank row', e);
        skipped += 1;
      }
    }

    res.send(
      `Imported ${inserted} new transactions, skipped ${skipped} (duplicates or blank rows). ` +
      `You can close this tab and check /api/transactions.`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to parse file: ${err.message}`);
  }
});

module.exports = { router };
