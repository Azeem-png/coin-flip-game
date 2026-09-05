-- CoinFlip D1 schema (ported from Mongoose models)
-- Money stored as REAL (same as Mongo doubles), time as INTEGER ms epoch.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  bal_inr REAL NOT NULL DEFAULT 0,
  bal_usd REAL NOT NULL DEFAULT 0,
  bal_eur REAL NOT NULL DEFAULT 0,
  bal_gbp REAL NOT NULL DEFAULT 0,
  preferred_currency TEXT NOT NULL DEFAULT 'INR',
  referral_code TEXT UNIQUE,
  referred_by TEXT REFERENCES users(id),
  referral_earnings REAL NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_losses INTEGER NOT NULL DEFAULT 0,
  total_wagered REAL NOT NULL DEFAULT 0,
  free_games INTEGER NOT NULL DEFAULT 0,
  free_wins INTEGER NOT NULL DEFAULT 0,
  free_losses INTEGER NOT NULL DEFAULT 0,
  real_games INTEGER NOT NULL DEFAULT 0,
  real_wins INTEGER NOT NULL DEFAULT 0,
  real_losses INTEGER NOT NULL DEFAULT 0,
  real_wagered REAL NOT NULL DEFAULT 0,
  is_email_verified INTEGER NOT NULL DEFAULT 0,
  otp TEXT,
  otp_expiry INTEGER,
  reset_token TEXT,
  reset_expiry INTEGER,
  last_login INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT,
  payment_details TEXT,
  admin_note TEXT,
  approved_by TEXT REFERENCES users(id),
  processed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_bet REAL NOT NULL DEFAULT 10,
  max_bet REAL NOT NULL DEFAULT 10000,
  min_deposit REAL NOT NULL DEFAULT 100,
  min_withdrawal REAL NOT NULL DEFAULT 100,
  commission_percent REAL NOT NULL DEFAULT 5,
  referral_commission_percent REAL NOT NULL DEFAULT 2,
  referral_bonus_enabled INTEGER NOT NULL DEFAULT 1,
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT NOT NULL DEFAULT '',
  default_currency TEXT NOT NULL DEFAULT 'INR',
  supported_currencies TEXT NOT NULL DEFAULT '["INR","USD","EUR","GBP"]',
  exchange_rates TEXT NOT NULL DEFAULT '{}',
  manual_draw INTEGER NOT NULL DEFAULT 0,
  free_manual_draw INTEGER NOT NULL DEFAULT 0,
  session_duration INTEGER NOT NULL DEFAULT 10,
  auto_resolve INTEGER NOT NULL DEFAULT 1,
  auto_commission INTEGER NOT NULL DEFAULT 1,
  platform_balance REAL NOT NULL DEFAULT 0,
  platform_total_earnings REAL NOT NULL DEFAULT 0,
  announcement TEXT NOT NULL DEFAULT '',
  announcement_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'betting',
  result TEXT,
  admin_set_result TEXT,
  is_auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON game_sessions(status);

CREATE TABLE IF NOT EXISTS game_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'real',
  bet_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  selected_side TEXT,
  result TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending',
  commission REAL NOT NULL DEFAULT 0,
  net_payout REAL NOT NULL DEFAULT 0,
  admin_forced INTEGER NOT NULL DEFAULT 0,
  balance_before REAL,
  balance_after REAL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_user ON game_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_session ON game_history(session_id, status);
