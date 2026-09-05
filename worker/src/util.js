import bcrypt from "bcryptjs";

export function sanitizeInput(body = {}, fields = []) {
	const out = { ...body };
	for (const f of fields) {
		if (typeof out[f] === "string") {
			out[f] = out[f].replace(/<[^>]*>/g, "").trim();
		}
	}
	return out;
}

export function validatePassword(password) {
	if (!password || password.length < 8) return "Password must be at least 8 characters";
	if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter";
	if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter";
	if (!/\d/.test(password)) return "Password must contain at least one number";
	if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return "Password must contain at least one special character";
	return null;
}

const PHONE_REGEX = /^[+]?[\d\s\-()]{7,15}$/;
export function validatePhone(phone) {
	if (!phone || !PHONE_REGEX.test(phone)) return "Valid phone number is required";
	return null;
}

export function generateOTP() {
	const arr = new Uint32Array(1);
	crypto.getRandomValues(arr);
	return String(100000 + (arr[0] % 900000));
}

export async function sha256hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64encode(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function b64decode(b64) {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// Fast native password hashing (PBKDF2). Old bcrypt hashes still verify via fallback.
export async function hashPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
	return `$pbkdf2$100000$${b64encode(salt)}$${b64encode(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
	if (!stored) return false;
	if (stored.startsWith("$pbkdf2$")) {
		try {
			const [, , iterStr, saltB64, hashB64] = stored.split("$");
			const salt = b64decode(saltB64);
			const expected = b64decode(hashB64);
			const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
			const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: Number(iterStr), hash: "SHA-256" }, key, expected.length * 8));
			if (bits.length !== expected.length) return false;
			let diff = 0;
			for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
			return diff === 0;
		} catch {
			return false;
		}
	}
	// Legacy bcrypt hashes (from MongoDB era)
	return bcrypt.compare(password, stored);
}
