import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { first, run, now, uid, getUserPublic, getSettings, toPublicUser } from "./db.js";
import { sanitizeInput, validatePassword, validatePhone, generateOTP, sha256hex, hashPassword, verifyPassword } from "./util.js";
import { sendOTPEmail, sendResetEmail } from "./email.js";
import { protect, loginLimiter, otpLimiter, forgotLimiter } from "./middleware.js";

const auth = new Hono();

function signToken(env, id, tokenVersion = 0) {
	return jwt.sign({ id, tokenVersion }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN || "7d" });
}

function referralCode() {
	return randomUUID().slice(0, 8).toUpperCase();
}

auth.post("/register", async (c) => {
	try {
		const body = sanitizeInput(await c.req.json().catch(() => ({})), ["name", "phone"]);
		const { name, email, phone, password, referralCode: refCode } = body;
		if (!name || !email || !phone || !password) {
			return c.json({ success: false, message: "All fields are required" }, 400);
		}
		const phoneError = validatePhone(phone);
		if (phoneError) return c.json({ success: false, message: phoneError }, 400);
		const passwordError = validatePassword(password);
		if (passwordError) return c.json({ success: false, message: passwordError }, 400);

		const db = c.env.DB;
		const emailLower = String(email).toLowerCase();
		const existing = await first(db, `SELECT id FROM users WHERE email = ?`, [emailLower]);
		if (existing) {
			return c.json({ success: false, message: "Email already registered", debug: "dup_email" }, 400);
		}

		let referredBy = null;
		if (refCode) {
			const referrer = await first(db, `SELECT id, email FROM users WHERE referral_code = ?`, [String(refCode).toUpperCase()]);
			if (referrer) {
				if (referrer.email === emailLower) {
					return c.json({ success: false, message: "Cannot use your own referral code" }, 400);
				}
				referredBy = referrer.id;
			}
		}

		const otp = generateOTP();
		const otpExpiry = now() + 10 * 60 * 1000;
		const id = uid();
		const hash = await hashPassword(password);
		await run(
			db,
			`INSERT INTO users (id, name, email, phone, password, referred_by, otp, otp_expiry, status, is_email_verified, referral_code, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
			[id, name, emailLower, phone, hash, referredBy, otp, otpExpiry, referralCode(), now()]
		);

		await sendOTPEmail(c.env, emailLower, otp, name);
		return c.json({ success: true, message: "Registration successful. OTP sent to your email.", userId: id }, 201);
	} catch (err) {
		console.error("register error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.post("/verify-otp", otpLimiter, async (c) => {
	try {
		const { userId, otp } = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		const user = await first(db, `SELECT * FROM users WHERE id = ?`, [userId]);
		if (!user) return c.json({ success: false, message: "User not found" }, 404);
		if (user.otp !== otp) return c.json({ success: false, message: "Invalid OTP" }, 400);
		if (!user.otp_expiry || user.otp_expiry < now()) return c.json({ success: false, message: "OTP expired" }, 400);
		await run(db, `UPDATE users SET is_email_verified = 1, otp = NULL, otp_expiry = NULL WHERE id = ?`, [userId]);
		const token = signToken(c.env, user.id, user.token_version);
		return c.json({
			success: true,
			message: "Email verified successfully",
			token,
			user: { id: user.id, name: user.name, email: user.email, role: user.role }
		});
	} catch (err) {
		console.error("verify-otp error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.post("/login", loginLimiter, async (c) => {
	try {
		const { email, password } = await c.req.json().catch(() => ({}));
		if (!email || !password) return c.json({ success: false, message: "Email and password required" }, 400);
		const db = c.env.DB;
		const user = await first(db, `SELECT * FROM users WHERE email = ?`, [String(email).toLowerCase()]);
		if (!user || !(await verifyPassword(password, user.password))) {
			return c.json({ success: false, message: "Invalid email or password" }, 401);
		}
		if (user.status === "banned") {
			return c.json({ success: false, message: "Your account has been banned. Contact support." }, 403);
		}
		if (!user.is_email_verified) {
			return c.json({
				success: true,
				emailVerified: false,
				userId: user.id,
				message: "Email not verified. Please verify your email first.",
				user: { id: user.id, name: user.name, email: user.email, isEmailVerified: false }
			});
		}
		await run(db, `UPDATE users SET last_login = ? WHERE id = ?`, [now(), user.id]);
		const token = signToken(c.env, user.id, user.token_version);
		const pub = toPublicUser(user);
		return c.json({
			success: true,
			emailVerified: true,
			token,
			user: {
				id: pub.id,
				name: pub.name,
				email: pub.email,
				phone: pub.phone,
				role: pub.role,
				balance: pub.balance,
				preferredCurrency: pub.preferredCurrency,
				referralCode: pub.referralCode,
				totalGames: pub.totalGames,
				totalWins: pub.totalWins,
				isEmailVerified: true
			}
		});
	} catch (err) {
		console.error("login error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.get("/me", protect, async (c) => {
	try {
		const user = await getUserPublic(c.env.DB, c.get("user").id);
		return c.json({ success: true, user });
	} catch (err) {
		console.error("me error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.patch("/profile", protect, async (c) => {
	try {
		const body = sanitizeInput(await c.req.json().catch(() => ({})), ["name", "phone"]);
		const { name, phone } = body;
		if (name && (name.length < 2 || name.length > 50)) {
			return c.json({ success: false, message: "Name must be 2-50 characters" }, 400);
		}
		if (phone) {
			const phoneError = validatePhone(phone);
			if (phoneError) return c.json({ success: false, message: phoneError }, 400);
		}
		const sets = [];
		const params = [];
		if (name) {
			sets.push("name = ?");
			params.push(name);
		}
		if (phone) {
			sets.push("phone = ?");
			params.push(phone);
		}
		if (sets.length) {
			params.push(c.get("user").id);
			await run(c.env.DB, `UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
		}
		const user = await getUserPublic(c.env.DB, c.get("user").id);
		return c.json({ success: true, message: "Profile updated", user });
	} catch (err) {
		console.error("profile error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.patch("/currency", protect, async (c) => {
	try {
		const { currency } = await c.req.json().catch(() => ({}));
		const settings = await getSettings(c.env.DB);
		if (!settings.supportedCurrencies.includes(currency)) {
			return c.json({ success: false, message: "Currency not supported" }, 400);
		}
		await run(c.env.DB, `UPDATE users SET preferred_currency = ? WHERE id = ?`, [currency, c.get("user").id]);
		return c.json({ success: true, message: "Currency updated", currency });
	} catch (err) {
		console.error("currency error:", err.message);
		return c.json({ success: false, message: "Login error: " + err.message }, 500);
	}
});

auth.post("/forgot-password", forgotLimiter, async (c) => {
	try {
		const { email } = await c.req.json().catch(() => ({}));
		if (!email) return c.json({ success: false, message: "Email is required" }, 400);
		const db = c.env.DB;
		const user = await first(db, `SELECT id, email FROM users WHERE email = ?`, [String(email).toLowerCase()]);
		if (user) {
			const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
			const hashed = await sha256hex(raw);
			await run(db, `UPDATE users SET reset_token = ?, reset_expiry = ? WHERE id = ?`, [hashed, now() + 15 * 60 * 1000, user.id]);
			const base = c.env.FRONTEND_URL || "https://coin-flip-game-4my6.onrender.com";
			await sendResetEmail(c.env, user.email, `${base}/reset-password.html?token=${raw}`);
		}
		return c.json({ success: true, message: "If the email exists, a reset link has been sent." });
	} catch (err) {
		console.error("forgot-password error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.post("/reset-password", async (c) => {
	try {
		const { email, token, password } = await c.req.json().catch(() => ({}));
		if (!email || !token || !password) {
			return c.json({ success: false, message: "Email, token, and new password are required" }, 400);
		}
		const hashed = await sha256hex(token);
		const db = c.env.DB;
		const user = await first(
			db,
			`SELECT id FROM users WHERE email = ? AND reset_token = ? AND reset_expiry > ?`,
			[String(email).toLowerCase(), hashed, now()]
		);
		if (!user) return c.json({ success: false, message: "Invalid or expired token" }, 400);
		await run(db, `UPDATE users SET password = ?, reset_token = NULL, reset_expiry = NULL WHERE id = ?`, [
			await hashPassword(password),
			user.id
		]);
		return c.json({ success: true, message: "Password reset successful. You can now login with your new password." });
	} catch (err) {
		console.error("reset-password error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.post("/change-password", protect, async (c) => {
	try {
		const { currentPassword, newPassword } = await c.req.json().catch(() => ({}));
		if (!currentPassword || !newPassword) {
			return c.json({ success: false, message: "Current password and new password are required" }, 400);
		}
		const passwordError = validatePassword(newPassword);
		if (passwordError) return c.json({ success: false, message: passwordError }, 400);
		const db = c.env.DB;
		const user = await first(db, `SELECT * FROM users WHERE id = ?`, [c.get("user").id]);
		if (!user) return c.json({ success: false, message: "User not found" }, 404);
		if (!(await verifyPassword(currentPassword, user.password))) {
			return c.json({ success: false, message: "Current password is incorrect" }, 401);
		}
		await run(db, `UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?`, [
			await hashPassword(newPassword),
			user.id
		]);
		return c.json({ success: true, message: "Password changed successfully" });
	} catch (err) {
		console.error("change-password error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

auth.post("/resend-otp", otpLimiter, async (c) => {
	try {
		const { userId } = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		const user = await first(db, `SELECT id, email, name FROM users WHERE id = ?`, [userId]);
		if (!user) return c.json({ success: false, message: "User not found" }, 404);
		const otp = generateOTP();
		await run(db, `UPDATE users SET otp = ?, otp_expiry = ? WHERE id = ?`, [otp, now() + 10 * 60 * 1000, userId]);
		await sendOTPEmail(c.env, user.email, otp, user.name);
		return c.json({ success: true, message: "OTP resent successfully" });
	} catch (err) {
		console.error("resend-otp error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

export default auth;
