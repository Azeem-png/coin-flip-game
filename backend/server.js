require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const logger = require('./utils/logger');

// Startup environment validation
const REQUIRED_ENV_VARS = ['MONGODB_URI', 'JWT_SECRET'];
let missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  logger.warn(`Missing required environment variables: ${missingVars.join(', ')}`);
  if (missingVars.includes('JWT_SECRET') && !process.env.JWT_SECRET) {
    process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
    logger.warn('JWT_SECRET not set — generated a random fallback. Existing sessions will be invalidated on restart.');
  }
  if (missingVars.includes('MONGODB_URI')) {
    logger.error('MONGODB_URI not set — database features will be unavailable.');
  }
}

const app = express();

app.set('trust proxy', 1);

// Ensure logs directory exists
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Connect Database
connectDB().then(() => {
  if (process.env.NODE_ENV !== 'production') {
    require('./config/seed')();
  }
  const { startSessionTimer, ensureActiveSession } = require('./services/sessionManager');
  return ensureActiveSession().then(() => {
    startSessionTimer();
  });
});

// Rate Limiting
const rateLimiter = require('./middleware/rateLimiter');
app.use('/api', rateLimiter);

// Security headers
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  scriptSrcAttr: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"]
};
if (process.env.FRONTEND_URL) {
  cspDirectives.connectSrc.push(process.env.FRONTEND_URL);
}
app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

// CORS - support comma-separated origins
const corsOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
  : ['http://localhost:5000', 'http://localhost:3000', 'http://127.0.0.1:5000'];
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'production') {
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    } else {
      logger.debug(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Serve frontend static files with cache headers
app.use(express.static(path.join(__dirname, '../frontend'), {
  maxAge: '1h',
  etag: true,
  lastModified: true
}));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/game', require('./routes/game'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/admin', require('./routes/admin'));

// Health check with DB status
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    success: true,
    message: 'CoinFlip API running',
    time: new Date(),
    uptime: process.uptime(),
    db: dbStatus[dbState] || 'unknown',
    memory: process.memoryUsage()
  });
});

// Public settings — only exposes safe, non-sensitive fields for frontend display
app.get('/api/settings-public', async (req, res) => {
  try {
    const Settings = require('./models/Settings');
    const settings = await Settings.getSettings();
    res.json({
      announcementEnabled: settings.announcementEnabled,
      announcement: settings.announcement,
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,
      minBet: settings.minBet,
      maxBet: settings.maxBet,
      commissionPercent: settings.commissionPercent,
      exchangeRates: settings.exchangeRates,
      supportedCurrencies: settings.supportedCurrencies,
      defaultCurrency: settings.defaultCurrency,
      sessionDuration: settings.sessionDuration
    });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// Serve admin HTML files explicitly
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin', 'index.html'));
});
app.get('/admin/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin', 'index.html'));
});
app.get('/admin/:page', (req, res) => {
  const page = req.params.page;
  const filePath = path.join(__dirname, '../frontend/admin', page.endsWith('.html') ? page : `${page}.html`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.sendFile(path.join(__dirname, '../frontend/admin', 'index.html'));
  }
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
  }
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, url: req.originalUrl, method: req.method });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Unhandled rejection / exception logging
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { error: reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  const { stopSessionTimer } = require('./services/sessionManager');
  stopSessionTimer();
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Error closing MongoDB', { error: err.message });
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  logger.info(`🚀 CoinFlip Server running on port ${PORT}`);
  logger.info(`🌐 Frontend: http://localhost:${PORT}`);
  logger.info(`📡 API: http://localhost:${PORT}/api`);
  logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);

});
 
module.exports = app;
