# PortfolioVault - Investment Portfolio Tracker

A full-stack investment portfolio tracker with user authentication, real-time stock prices, and PostgreSQL database storage. **Optimized for Render.com deployment.**

![PortfolioVault](https://img.shields.io/badge/Status-Production%20Ready-green)
![Node.js](https://img.shields.io/badge/Node.js-18+-blue)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-blue)
![Render](https://img.shields.io/badge/Deploy-Render.com-purple)

## Features

- 🔐 **User Authentication** - Secure signup/login with bcrypt password hashing
- 💼 **Portfolio Management** - Track stocks, shares, cost basis, and purchase dates
- 💵 **Cash Tracking** - Monitor cash balance with APY yield
- 📈 **Real-time Prices** - Live stock quotes from Finnhub API
- 📊 **Performance Charts** - Interactive historical portfolio value graphs
- 💰 **Buy/Sell Orders** - Enter buys (deduct from cash) and sells (add to cash)
- 🔄 **Session Persistence** - Stay logged in across browser sessions
- 🌐 **Multi-user** - Each user has completely isolated data
- 📱 **Responsive** - Works on desktop and mobile

---

## 🚀 Deploy to Render (Recommended)

### Option 1: One-Click Deploy (Easiest)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Click the button above
2. Connect your GitHub account
3. Render will automatically:
   - Create a PostgreSQL database
   - Deploy the web service
   - Set up environment variables
4. Wait 2-3 minutes for deployment
5. Access your app at `https://portfolio-vault.onrender.com`

### Option 2: Manual Deploy

1. **Fork this repository** to your GitHub account

2. **Create a Render account** at https://render.com

3. **Create PostgreSQL Database:**
   - Go to Dashboard → New → PostgreSQL
   - Name: `portfolio-db`
   - Plan: Free
   - Click "Create Database"
   - Copy the "Internal Database URL"

4. **Create Web Service:**
   - Go to Dashboard → New → Web Service
   - Connect your GitHub repository
   - Configure:
     - **Name:** `portfolio-vault`
     - **Root Directory:** `backend`
     - **Environment:** `Node`
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Plan:** Free

5. **Set Environment Variables:**
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = (paste the Internal Database URL from step 3)
   - `SESSION_SECRET` = (click "Generate" for a random secret)

6. Click **"Create Web Service"** and wait for deployment

---

## 💻 Run Locally

### Prerequisites
- Node.js 18 or higher
- PostgreSQL (or use Docker)

### Quick Start

```bash
# Clone the repo
git clone https://github.com/yourusername/portfolio-vault.git
cd portfolio-vault/backend

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your database URL

# Run locally
npm start
```

### Using Docker for PostgreSQL

```bash
# Start PostgreSQL container
docker run --name portfolio-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=portfolio -p 5432:5432 -d postgres:15

# Set DATABASE_URL
export DATABASE_URL=postgresql://postgres:password@localhost:5432/portfolio

# Run the app
npm start
```

Then open http://localhost:10000

---

## 📁 Project Structure

```
portfolio-render/
├── render.yaml              # Render deployment configuration
├── backend/
│   ├── package.json         # Dependencies
│   ├── server.js            # Express API server
│   ├── .env.example         # Environment variables template
│   └── public/
│       └── index.html       # React frontend (single file)
```

---

## 🔌 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create new account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Check auth status |

### Portfolio
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/positions` | Get all positions |
| POST | `/api/positions` | Add/update position |
| POST | `/api/positions/sell` | Sell shares |
| DELETE | `/api/positions/:ticker` | Remove position |

### Cash
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cash` | Get cash balance |
| POST | `/api/cash` | Update cash balance |

### History
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/history` | Get portfolio history |
| POST | `/api/history` | Save daily snapshot |
| GET | `/api/transactions` | Get transaction log |

### Health Check
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (for Render) |

---

## 🗄️ Database Schema

```sql
-- Users
users (id, username, password_hash, created_at, last_login)

-- Stock positions
positions (id, user_id, ticker, shares, cost_basis, total_cost, purchase_date, name)

-- Cash balance
cash (id, user_id, amount, yield_rate)

-- Daily portfolio snapshots
portfolio_history (id, user_id, date, total_value)

-- Buy/sell log
transactions (id, user_id, ticker, type, shares, price, total, date)

-- Sessions (for auth)
session (sid, sess, expire)
```

---

## 🔒 Security Features

- **Password Hashing:** bcrypt with 12 rounds
- **Session Management:** PostgreSQL-backed sessions with 7-day expiry
- **HTTPS:** Automatic on Render
- **SQL Injection Protection:** Parameterized queries
- **CORS:** Configured for production
- **Helmet.js:** Security headers
- **Input Validation:** Username/password requirements

---

## 📊 Stock Data

Stock prices are fetched from **Finnhub API** (free tier):
- Real-time quotes during market hours
- 60 requests/minute limit
- Automatic fallback for unknown symbols

To use your own API key:
1. Register at https://finnhub.io
2. Replace `demo` in the frontend with your key

---

## 🛠️ Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SESSION_SECRET` | Secret for session encryption | Yes |
| `NODE_ENV` | `development` or `production` | No |
| `PORT` | Server port (default: 10000) | No |
| `FRONTEND_URL` | Frontend URL for CORS | No |

---

## 📱 Usage

1. **Sign Up:** Create an account with username/password
2. **Add Cash:** Click the cash card to set your starting balance
3. **Add Investments:** Click "Add Investment" to log your holdings
4. **Track Performance:** View real-time values and historical charts
5. **Buy/Sell:** Use the buy/sell features to track trades

---

## 🆓 Free Tier Limits (Render)

- **Web Service:** Spins down after 15 min of inactivity (first request may be slow)
- **Database:** 1GB storage, 97 hours compute/month
- **Good for:** Personal use, demos, small teams

For production, consider upgrading to paid plans.

---

## 📄 License

MIT License - feel free to use for personal or commercial projects.

---

## 🤝 Contributing

Pull requests welcome! Please open an issue first to discuss changes.

---

Made with ❤️ for investors who want to track their portfolios
