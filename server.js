require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const transactionsRouter = require('./routes/transactions');
const { router: gmailRouter, syncGmail } = require('./routes/gmail');
const { router: bankRouter } = require('./routes/bank');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Finance app server is running.');
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api/transactions', transactionsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/bank', bankRouter);

cron.schedule('0 6 * * *', async () => {
  try {
    const result = await syncGmail(2);
    console.log(`[cron] Gmail sync: scanned ${result.scanned}, inserted ${result.inserted}`);
  } catch (err) {
    console.error('[cron] Gmail sync failed:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
