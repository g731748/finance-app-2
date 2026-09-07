const express = require('express');
const pool = require('../db/pool');
const { classifyTransaction } = require('../utils/classify');

const router = express.Router();

// GET /api/transactions?year=2026&month=03
router.get('/', async (req, res) => {
  const { year, month } = req.query;
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (year) {
    params.push(year);
    query += ` AND EXTRACT(YEAR FROM date) = $${params.length}`;
  }
  if (month) {
    params.push(month);
    query += ` AND EXTRACT(MONTH FROM date) = $${params.length}`;
  }
  query += ' ORDER BY date DESC';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// POST /api/transactions
router.post('/', async (req, res) => {
  const { date, type, amount, category, note, vat_eligible, domain_category } = req.body;

  if (!date || !type || !amount || amount <= 0 || !['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'Missing or invalid date/type/amount' });
  }

  try {
    const autoCategory = domain_category || classifyTransaction({ category, note });
    const result = await pool.query(
      `INSERT INTO transactions (date, type, amount, category, note, vat_eligible, source, domain_category)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7) RETURNING *`,
      [date, type, amount, category || '', note || '', vat_eligible !== false, autoCategory]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// GET /api/transactions/reclassify -- runs the keyword classifier over every
// transaction that doesn't have a domain_category yet, and fills in what it
// can recognize. Visit this URL in your browser after importing new data.
router.get('/reclassify', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, category, note FROM transactions WHERE domain_category IS NULL OR domain_category = ''`
    );
    let updated = 0;
    for (const row of result.rows) {
      const guess = classifyTransaction({ category: row.category, note: row.note });
      if (guess) {
        await pool.query(`UPDATE transactions SET domain_category = $1 WHERE id = $2`, [guess, row.id]);
        updated += 1;
      }
    }
    res.send(
      `Checked ${result.rows.length} unclassified transactions, auto-classified ${updated}. ` +
      `The rest need a manual pick in the ledger (they don't have enough info in their description). ` +
      `You can close this tab.`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to reclassify: ${err.message}`);
  }
});

// PATCH /api/transactions/:id/category  { domain_category: "מזון" }
router.patch('/:id/category', async (req, res) => {
  const { domain_category } = req.body;
  if (typeof domain_category !== 'string') {
    return res.status(400).json({ error: 'Missing domain_category' });
  }
  try {
    const result = await pool.query(
      `UPDATE transactions SET domain_category = $1 WHERE id = $2 RETURNING *`,
      [domain_category, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

module.exports = router;
