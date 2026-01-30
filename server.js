require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// DATABASE CONNECTION (PostgreSQL on Render)
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected at:', res.rows[0].now);
  }
});

// ============================================
// INITIALIZE DATABASE TABLES
// ============================================
const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );

      -- Positions table (user's stock holdings)
      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ticker VARCHAR(10) NOT NULL,
        shares DECIMAL(18,6) NOT NULL,
        cost_basis DECIMAL(18,6) NOT NULL,
        total_cost DECIMAL(18,2) NOT NULL,
        purchase_date DATE NOT NULL,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, ticker)
      );

      -- Cash table (user's cash balance)
      CREATE TABLE IF NOT EXISTS cash (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(18,2) DEFAULT 0,
        yield_rate DECIMAL(5,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Portfolio history (daily snapshots for charts)
      CREATE TABLE IF NOT EXISTS portfolio_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        total_value DECIMAL(18,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );

      -- Transactions log (buy/sell history)
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ticker VARCHAR(10) NOT NULL,
        type VARCHAR(4) NOT NULL CHECK(type IN ('buy', 'sell')),
        shares DECIMAL(18,6) NOT NULL,
        price DECIMAL(18,6) NOT NULL,
        total DECIMAL(18,2) NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Session table for express-session
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
      CREATE INDEX IF NOT EXISTS idx_history_user_date ON portfolio_history(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    `);
    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  } finally {
    client.release();
  }
};

initDatabase();

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable for now to allow CDN scripts
  crossOriginEmbedderPolicy: false
}));

// Compression
app.use(compression());

// CORS configuration
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000'
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin.startsWith(allowed) || allowed === '*')) {
      return callback(null, true);
    }
    // In production, be more permissive for Render's domains
    if (process.env.NODE_ENV === 'production' && origin.includes('onrender.com')) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for now
  },
  credentials: true
}));

// Body parsing
app.use(express.json());

// Session configuration with PostgreSQL store
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production-1234567890',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  },
  proxy: true // Trust Render's proxy
}));

// Trust proxy (required for Render)
app.set('trust proxy', 1);

// Serve static files from frontend
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

// ============================================
// HEALTH CHECK (Required by Render)
// ============================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// AUTH ROUTES
// ============================================

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [cleanUsername, passwordHash]
    );

    const user = result.rows[0];

    // Initialize cash for new user
    await pool.query('INSERT INTO cash (user_id, amount, yield_rate) VALUES ($1, 0, 0)', [user.id]);

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Find user
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [cleanUsername]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Check auth status
app.get('/api/auth/me', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username } });
  } else {
    res.json({ authenticated: false });
  }
});

// ============================================
// POSITIONS ROUTES
// ============================================

// Get all positions
app.get('/api/positions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add/update position
app.post('/api/positions', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { ticker, shares, costBasis, totalCost, purchaseDate, name, isBuy } = req.body;
    const userId = req.session.userId;
    const upperTicker = ticker.toUpperCase();

    await client.query('BEGIN');

    // Check if position exists
    const existing = await client.query(
      'SELECT * FROM positions WHERE user_id = $1 AND ticker = $2',
      [userId, upperTicker]
    );

    if (existing.rows.length > 0) {
      // Update existing position
      const pos = existing.rows[0];
      const newShares = parseFloat(pos.shares) + shares;
      const newTotalCost = parseFloat(pos.total_cost) + totalCost;
      const newCostBasis = newTotalCost / newShares;

      await client.query(
        `UPDATE positions SET shares = $1, cost_basis = $2, total_cost = $3, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $4 AND ticker = $5`,
        [newShares, newCostBasis, newTotalCost, userId, upperTicker]
      );
    } else {
      // Create new position
      await client.query(
        `INSERT INTO positions (user_id, ticker, shares, cost_basis, total_cost, purchase_date, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, upperTicker, shares, costBasis, totalCost, purchaseDate, name || upperTicker]
      );
    }

    // Deduct from cash if buy order
    if (isBuy) {
      await client.query(
        'UPDATE cash SET amount = amount - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
        [totalCost, userId]
      );
    }

    // Log transaction
    await client.query(
      'INSERT INTO transactions (user_id, ticker, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, upperTicker, 'buy', shares, costBasis, totalCost]
    );

    await client.query('COMMIT');

    // Return updated positions
    const positions = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [userId]);
    res.json(positions.rows);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add position error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Sell shares
app.post('/api/positions/sell', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { ticker, shares, salePrice, totalProceeds } = req.body;
    const userId = req.session.userId;
    const upperTicker = ticker.toUpperCase();

    await client.query('BEGIN');

    const result = await client.query(
      'SELECT * FROM positions WHERE user_id = $1 AND ticker = $2',
      [userId, upperTicker]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Position not found' });
    }

    const position = result.rows[0];

    if (shares > parseFloat(position.shares)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot sell more shares than owned' });
    }

    if (shares >= parseFloat(position.shares)) {
      // Sell all - delete position
      await client.query('DELETE FROM positions WHERE user_id = $1 AND ticker = $2', [userId, upperTicker]);
    } else {
      // Partial sell
      const newShares = parseFloat(position.shares) - shares;
      const newTotalCost = parseFloat(position.cost_basis) * newShares;
      await client.query(
        'UPDATE positions SET shares = $1, total_cost = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND ticker = $4',
        [newShares, newTotalCost, userId, upperTicker]
      );
    }

    // Add proceeds to cash
    await client.query(
      'UPDATE cash SET amount = amount + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [totalProceeds, userId]
    );

    // Log transaction
    await client.query(
      'INSERT INTO transactions (user_id, ticker, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, upperTicker, 'sell', shares, salePrice, totalProceeds]
    );

    await client.query('COMMIT');

    const positions = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [userId]);
    res.json(positions.rows);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Sell error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Delete position
app.delete('/api/positions/:ticker', requireAuth, async (req, res) => {
  try {
    const { ticker } = req.params;
    await pool.query('DELETE FROM positions WHERE user_id = $1 AND ticker = $2', [req.session.userId, ticker.toUpperCase()]);
    const positions = await pool.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY ticker', [req.session.userId]);
    res.json(positions.rows);
  } catch (error) {
    console.error('Delete position error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// CASH ROUTES
// ============================================

app.get('/api/cash', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cash WHERE user_id = $1', [req.session.userId]);
    res.json(result.rows[0] || { amount: 0, yield_rate: 0 });
  } catch (error) {
    console.error('Get cash error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cash', requireAuth, async (req, res) => {
  try {
    const { amount, yieldRate } = req.body;
    await pool.query(
      `INSERT INTO cash (user_id, amount, yield_rate) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET amount = $2, yield_rate = $3, updated_at = CURRENT_TIMESTAMP`,
      [req.session.userId, amount, yieldRate]
    );
    const result = await pool.query('SELECT * FROM cash WHERE user_id = $1', [req.session.userId]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update cash error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// HISTORY ROUTES
// ============================================

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT date, total_value as value FROM portfolio_history WHERE user_id = $1 ORDER BY date ASC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/history', requireAuth, async (req, res) => {
  try {
    const { totalValue } = req.body;
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO portfolio_history (user_id, date, total_value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, date) DO UPDATE SET total_value = $3`,
      [req.session.userId, today, totalValue]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Save history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get transactions
app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC LIMIT 100',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// SERVE FRONTEND (Catch-all route)
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🚀 PortfolioVault Server Running!                      ║
║                                                          ║
║   Port: ${PORT}                                             ║
║   Environment: ${process.env.NODE_ENV || 'development'}                            ║
║   Database: PostgreSQL                                   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
