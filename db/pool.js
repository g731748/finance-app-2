const { Pool } = require('pg');

// Railway injects DATABASE_URL automatically once you attach a Postgres
// plugin to your project -- you don't need to build this string yourself.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = pool;
