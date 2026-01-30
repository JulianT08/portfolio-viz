const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

// Note: dotenv not needed on Render - env vars are set in dashboard

const app = express();
const PORT = process.env.PORT || 10000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('DB connection failed:', err.message);
  else console.log('DB connected:', res.rows[0].now);
});

// Initialize database tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        ticker VARCHAR(10) NOT NULL,
        shares DECIMAL(18,6) NOT NULL,
        cost_basis DECIMAL(18,6) NOT NULL,
        total_cost DECIMAL(18,2) NOT NULL,
        purchase_date DATE NOT NULL,
        name VARCHAR(100),
        UNIQUE(user_id, ticker)
      );
      CREATE TABLE IF NOT EXISTS cash (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(18,2) DEFAULT 0,
        yield_rate DECIMAL(5,2) DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS portfolio_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        total_value DECIMAL(18,2) NOT NULL,
        UNIQUE(user_id, date)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        ticker VARCHAR(10) NOT NULL,
        type VARCHAR(4) CHECK(type IN ('buy', 'sell')),
        shares DECIMAL(18,6) NOT NULL,
        price DECIMAL(18,6) NOT NULL,
        total DECIMAL(18,2) NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" VARCHAR NOT NULL PRIMARY KEY,
        "sess" JSON NOT NULL,
        "expire" TIMESTAMP(6) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);
    console.log('DB tables ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
};
initDB();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    
    const clean = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [clean]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Username already exists' });
    
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [clean, hash]);
    const user = result.rows[0];
    
    await pool.query('INSERT INTO cash (user_id, amount, yield_rate) VALUES ($1, 0, 0)', [user.id]);
    
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const clean = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [clean]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username } });
  } else {
    res.json({ authenticated: false });
  }
});

// Positions routes
app.get('/api/positions', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/positions', auth, async (req, res) => {
  try {
    const { ticker, shares, costBasis, totalCost, purchaseDate, name, isBuy } = req.body;
    const userId = req.session.userId;
    const t = ticker.toUpperCase();
    
    const exists = await pool.query('SELECT * FROM positions WHERE user_id = $1 AND ticker = $2', [userId, t]);
    
    if (exists.rows.length > 0) {
      const p = exists.rows[0];
      const newShares = parseFloat(p.shares) + shares;
      const newTotal = parseFloat(p.total_cost) + totalCost;
      const newBasis = newTotal / newShares;
      await pool.query('UPDATE positions SET shares = $1, cost_basis = $2, total_cost = $3 WHERE user_id = $4 AND ticker = $5',
        [newShares, newBasis, newTotal, userId, t]);
    } else {
      await pool.query('INSERT INTO positions (user_id, ticker, shares, cost_basis, total_cost, purchase_date, name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, t, shares, costBasis, totalCost, purchaseDate, name || t]);
    }
    
    if (isBuy) {
      await pool.query('UPDATE cash SET amount = amount - $1 WHERE user_id = $2', [totalCost, userId]);
    }
    
    await pool.query('INSERT INTO transactions (user_id, ticker, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, t, 'buy', shares, costBasis, totalCost]);
    
    const result = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/positions/sell', auth, async (req, res) => {
  try {
    const { ticker, shares, salePrice, totalProceeds } = req.body;
    const userId = req.session.userId;
    const t = ticker.toUpperCase();
    
    const result = await pool.query('SELECT * FROM positions WHERE user_id = $1 AND ticker = $2', [userId, t]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Position not found' });
    
    const pos = result.rows[0];
    if (shares > parseFloat(pos.shares)) return res.status(400).json({ error: 'Cannot sell more than owned' });
    
    if (shares >= parseFloat(pos.shares)) {
      await pool.query('DELETE FROM positions WHERE user_id = $1 AND ticker = $2', [userId, t]);
    } else {
      const newShares = parseFloat(pos.shares) - shares;
      const newTotal = parseFloat(pos.cost_basis) * newShares;
      await pool.query('UPDATE positions SET shares = $1, total_cost = $2 WHERE user_id = $3 AND ticker = $4',
        [newShares, newTotal, userId, t]);
    }
    
    await pool.query('UPDATE cash SET amount = amount + $1 WHERE user_id = $2', [totalProceeds, userId]);
    await pool.query('INSERT INTO transactions (user_id, ticker, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, t, 'sell', shares, salePrice, totalProceeds]);
    
    const positions = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [userId]);
    res.json(positions.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/positions/:ticker', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM positions WHERE user_id = $1 AND ticker = $2', [req.session.userId, req.params.ticker.toUpperCase()]);
    const result = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cash routes
app.get('/api/cash', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cash WHERE user_id = $1', [req.session.userId]);
    res.json(result.rows[0] || { amount: 0, yield_rate: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cash', auth, async (req, res) => {
  try {
    const { amount, yieldRate } = req.body;
    await pool.query(
      'INSERT INTO cash (user_id, amount, yield_rate) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET amount = $2, yield_rate = $3',
      [req.session.userId, amount, yieldRate]
    );
    const result = await pool.query('SELECT * FROM cash WHERE user_id = $1', [req.session.userId]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// History routes
app.get('/api/history', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT date, total_value as value FROM portfolio_history WHERE user_id = $1 ORDER BY date', [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/history', auth, async (req, res) => {
  try {
    const { totalValue } = req.body;
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      'INSERT INTO portfolio_history (user_id, date, total_value) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET total_value = $3',
      [req.session.userId, today, totalValue]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
