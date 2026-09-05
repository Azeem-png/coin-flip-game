import jwt from "jsonwebtoken";
import { first } from "./db.js";

function getToken(c) {
	const header = c.req.header("Authorization") || "";
	if (header.startsWith("Bearer ")) return header.slice(7);
	const cookie = c.req.header("Cookie") || "";
	const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

export async function protect(c, next) {
	const token = getToken(c);
	if (!token) return c.json({ success: false, message: "Not authorized, no token" }, 401);
	if (!c.env.JWT_SECRET) return c.json({ success: false, message: "Server configuration error" }, 500);
	let decoded;
	try {
		decoded = jwt.verify(token, c.env.JWT_SECRET);
	} catch (err) {
		if (err && err.name === "TokenExpiredError") {
			return c.json({ success: false, message: "Session expired, please login again", code: "TOKEN_EXPIRED" }, 401);
		}
		return c.json({ success: false, message: "Not authorized, invalid token", code: "INVALID_TOKEN" }, 401);
	}
	const user = await first(c.env.DB, `SELECT * FROM users WHERE id = ?`, [decoded.id]);
	if (!user) return c.json({ success: false, message: "User not found", code: "USER_NOT_FOUND" }, 401);
	if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.token_version) {
		return c.json({ success: false, message: "Session expired, please login again", code: "TOKEN_VERSION_MISMATCH" }, 401);
	}
	if (user.status === "banned") {
		return c.json({ success: false, message: "Your account has been banned. Contact support." }, 403);
	}
	c.set("user", user);
	await next();
}

export async function requireVerified(c, next) {
	const user = c.get("user");
	if (!user || !user.is_email_verified) {
		return c.json({ success: false, message: "Please verify your email before using this feature." }, 403);
	}
	await next();
}

export async function adminAuth(c, next) {
	const user = c.get("user");
	if (!user || user.role !== "admin") {
		return c.json({ success: false, message: "Admin access required." }, 403);
	}
	await next();
}

// In-memory per-isolate limiters (same rules as Express version).
const loginMap = new Map();
const otpMap = new Map();
const forgotMap = new Map();
let lastPrune = 0;

function prune() {
	const nowT = Date.now();
	if (nowT - lastPrune < 120000) return;
	lastPrune = nowT;
	const cutoff = nowT - 120000;
	for (const [k, v] of loginMap) if (v.start < cutoff) loginMap.delete(k);
	for (const [k, v] of otpMap) if (v < cutoff) otpMap.delete(k);
	for (const [k, v] of forgotMap) if (v.start < cutoff) forgotMap.delete(k);
}

export async function loginLimiter(c, next) {
	prune();
	const key = c.req.header("CF-Connecting-IP") || "unknown";
	const nowT = Date.now();
	const entry = loginMap.get(key) || { count: 0, start: nowT };
	if (nowT - entry.start > 60000) {
		entry.count = 0;
		entry.start = nowT;
	}
	entry.count++;
	loginMap.set(key, entry);
	if (entry.count > 5) {
		return c.json({ success: false, message: "Too many login attempts. Try again after a minute." }, 429);
	}
	await next();
}

export async function otpLimiter(c, next) {
	prune();
	const key = c.req.header("CF-Connecting-IP") || "unknown";
	const last = otpMap.get(key) || 0;
	if (Date.now() - last < 5000) {
		return c.json({ success: false, message: "Too many attempts. Wait 5 seconds." }, 429);
	}
	otpMap.set(key, Date.now());
	await next();
}

export async function forgotLimiter(c, next) {
	prune();
	const key = c.req.header("CF-Connecting-IP") || "unknown";
	const nowT = Date.now();
	const entry = forgotMap.get(key) || { count: 0, start: nowT };
	if (nowT - entry.start > 60000) {
		entry.count = 0;
		entry.start = nowT;
	}
	entry.count++;
	forgotMap.set(key, entry);
	if (entry.count > 3) {
		return c.json({ success: false, message: "Too many requests. Try again after a minute." }, 429);
	}
	await next();
}
