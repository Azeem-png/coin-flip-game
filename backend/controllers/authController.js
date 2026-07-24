const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const nodemailer = require('nodemailer');
const https = require('https');
const { sanitizeInput } = require('../utils/sanitize');
const logger = require('../utils/logger');

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/\d/.test(password)) {
    return 'Password must contain at least one number';
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return 'Password must contain at least one special character';
  }
  return null;
}

const PHONE_REGEX = /^[+]?[\d\s\-()]{7,15}$/;
function validatePhone(phone) {
  if (!phone || !PHONE_REGEX.test(phone)) {
    return 'Valid phone number is required';
  }
  return null;
}

// Generate JWT
const generateToken = (id, tokenVersion = 0) => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign({ id, tokenVersion }, secret, { expiresIn });
};

// Generate OTP
const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// Send email via Brevo API (preferred) or SMTP fallback
const sendEmail = async (to, subject, html) => {
  const brevoKey = process.env.BREVO_API_KEY;
  if (brevoKey) {
    try {
      const data = JSON.stringify({
        sender: { email: process.env.EMAIL_USER || 'noreply.coinflip.support@gmail.com', name: 'CoinFlip Game' },
        to: [{ email: to }],
        subject,
        htmlContent: html
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
          headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 5000
        }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(data); req.end();
      });
      return true;
    } catch (err) {
      logger.warn('Brevo error', { error: err.message });
      console.error('BREVO_ERROR:', err.message);
    }
  }
  // SMTP fallback (may not work on Render free tier)
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.EMAIL_PORT) || 587,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      connectionTimeout: 5000,
      greetingTimeout: 5000
    });
    await transporter.sendMail({ from: `"CoinFlip Game" <${process.env.EMAIL_USER}>`, to, subject, html });
    return true;
  } catch (err) {
    logger.warn('SMTP email error', { error: err.message });
    console.error('SMTP_ERROR:', err.message);
    return false;
  }
};

const sendOTPEmail = async (email, otp, name) => {
  const html = `<h2>Hello ${name}!</h2><p>Your OTP is: <strong>${otp}</strong></p><p>Valid for 10 minutes.</p>`;
  await sendEmail(email, 'Your OTP - CoinFlip Game', html);
};

// @route POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const sanitized = sanitizeInput(req.body, ['name', 'phone']);
    const { name, email, phone, password, referralCode } = sanitized;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const phoneError = validatePhone(phone);
    if (phoneError) {
      return res.status(400).json({ success: false, message: phoneError });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered', debug: 'dup_email' });
    }

    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) {
        if (referrer.email === email.toLowerCase()) {
          return res.status(400).json({ success: false, message: 'Cannot use your own referral code' });
        }
        referredBy = referrer._id;
      }
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const user = await User.create({
      name, email: email.toLowerCase(), phone, password,
      referredBy, otp, otpExpiry, status: 'active', isEmailVerified: false
    });

    await sendOTPEmail(email, otp, name);

    res.status(201).json({
      success: true,
      message: 'Registration successful. OTP sent to your email.',
      userId: user._id,
      debugOtp: String(otp)
    });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route POST /api/auth/verify-otp
exports.verifyOTP = async (req, res) => {
  try {
    const { userId, otp } = req.body;
    const user = await User.findById(userId).select('+otp +otpExpiry');

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (user.otpExpiry < Date.now()) return res.status(400).json({ success: false, message: 'OTP expired' });

    user.isEmailVerified = true;
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();

    const token = generateToken(user._id, user.tokenVersion);
    res.json({ success: true, message: 'Email verified successfully', token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

    logger.debug('Login attempt', { email });
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (user.status === 'banned') {
      return res.status(403).json({ success: false, message: 'Your account has been banned. Contact support.' });
    }

    if (!user.isEmailVerified) {
      return res.status(200).json({
        success: true,
        emailVerified: false,
        userId: user._id,
        message: 'Email not verified. Please verify your email first.',
        user: { id: user._id, name: user.name, email: user.email, isEmailVerified: false }
      });
    }

    user.lastLogin = Date.now();
    await user.save();

    const token = generateToken(user._id, user.tokenVersion);
    res.json({
      success: true,
      emailVerified: true,
      token,
      user: {
        id: user._id, name: user.name, email: user.email,
        phone: user.phone, role: user.role, balance: user.balance,
        preferredCurrency: user.preferredCurrency, referralCode: user.referralCode,
        totalGames: user.totalGames, totalWins: user.totalWins, isEmailVerified: true
      }
    });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route GET /api/auth/me
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({ success: true, user });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route PATCH /api/auth/profile
exports.updateProfile = async (req, res) => {
  try {
    const sanitized = sanitizeInput(req.body, ['name', 'phone']);
    const { name, phone } = sanitized;
    const updates = {};
    if (name) {
      if (name.length < 2 || name.length > 50) {
        return res.status(400).json({ success: false, message: 'Name must be 2-50 characters' });
      }
      updates.name = name;
    }
    if (phone) {
      const phoneError = validatePhone(phone);
      if (phoneError) return res.status(400).json({ success: false, message: phoneError });
      updates.phone = phone;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates);
    res.json({ success: true, message: 'Profile updated', user });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route PATCH /api/auth/currency
exports.updateCurrency = async (req, res) => {
  try {
    const { currency } = req.body;
    const Settings = require('../models/Settings');
    const settings = await Settings.getSettings();

    if (!settings.supportedCurrencies.includes(currency)) {
      return res.status(400).json({ success: false, message: 'Currency not supported' });
    }

    await User.findByIdAndUpdate(req.user._id, { preferredCurrency: currency });
    res.json({ success: true, message: 'Currency updated', currency });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Login error: ' + error.message });
  }
};

// @route POST /api/auth/forgot-password
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(200).json({ success: true, message: 'If the email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password.html?token=${resetToken}`;

    const html = `<h2>Password Reset</h2><p>Use the token below to reset your password. Valid for 15 minutes.</p><p style="font-size:24px;text-align:center;background:#f5f5f5;padding:12px;letter-spacing:4px;font-family:monospace;"><strong>${resetToken}</strong></p><p>Visit: <a href="${resetUrl}">${resetUrl}</a> and enter the token along with your new password.</p><p>If you didn't request this, ignore this email.</p>`;
    await sendEmail(user.email, 'Password Reset - CoinFlip Game', html);

    res.json({ success: true, message: 'If the email exists, a reset link has been sent.', debugResetToken: resetToken });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route POST /api/auth/reset-password
exports.resetPassword = async (req, res) => {
  try {
    const { email, token, password } = req.body;
    if (!email || !token || !password) {
      return res.status(400).json({ success: false, message: 'Email, token, and new password are required' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      email: email.toLowerCase(),
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: Date.now() }
    }).select('+password');

    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;
    await user.save();

    res.json({ success: true, message: 'Password reset successful. You can now login with your new password.' });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};



// @route POST /api/auth/change-password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @route POST /api/auth/resend-otp
exports.resendOTP = async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const otp = generateOTP();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();
    await sendOTPEmail(user.email, otp, user.name);

    res.json({ success: true, message: 'OTP resent successfully' });
  } catch (error) {
    logger.error('AuthController error', { error: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

