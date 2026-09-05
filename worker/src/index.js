import { Hono } from "hono";
import { cors } from "hono/cors";
import { getSettings } from "./db.js";
import authRoutes from "./auth.js";
import gameRoutes from "./game.js";
import walletRoutes from "./wallet.js";
import referralRoutes from "./referral.js";
import adminRoutes from "./admin.js";

const app = new Hono();

app.use("/api/*", async (c, next) => {
	const origins = (c.env.FRONTEND_URL || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const middleware = cors({
		origin: origins.length ? origins : ["http://localhost:5000", "http://localhost:3000"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true
	});
	return middleware(c, next);
});

// Global /api sliding-window limiter (parity with Express version: 200 req/min/IP).
const globalHits = new Map();
let globalPrune = 0;

app.use("/api/*", async (c, next) => {
	const t = Date.now();
	if (t - globalPrune > 60000) {
		globalPrune = t;
		for (const [k, v] of globalHits) {
			while (v.length && v[0] <= t - 60000) v.shift();
			if (!v.length) globalHits.delete(k);
		}
	}
	const key = c.req.header("CF-Connecting-IP") || "unknown";
	let arr = globalHits.get(key);
	if (!arr) {
		arr = [];
		globalHits.set(key, arr);
	}
	while (arr.length && arr[0] <= t - 60000) arr.shift();
	arr.push(t);
	if (arr.length > 200) {
		return c.json({ success: false, message: "Too many requests, slow down." }, 429);
	}
	await next();
});

app.get("/api/health", async (c) => {
	let dbStatus = "unknown";
	try {
		await c.env.DB.prepare("SELECT 1").first();
		dbStatus = "connected";
	} catch {
		dbStatus = "disconnected";
	}
	return c.json({ success: true, message: "CoinFlip API running", time: new Date(), db: dbStatus });
});

app.get("/api/settings-public", async (c) => {	try {
		const s = await getSettings(c.env.DB);
		return c.json({
			announcementEnabled: s.announcementEnabled,
			announcement: s.announcement,
			maintenanceMode: s.maintenanceMode,
			maintenanceMessage: s.maintenance_message,
			minBet: s.min_bet,
			maxBet: s.max_bet,
			commissionPercent: s.commission_percent,
			exchangeRates: s.exchangeRates,
			supportedCurrencies: s.supportedCurrencies,
			defaultCurrency: s.default_currency,
			sessionDuration: s.session_duration
		});
	} catch {
		return c.json({ success: false }, 500);
	}
});

app.route("/api/auth", authRoutes);
app.route("/api/game", gameRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/referral", referralRoutes);
app.route("/api/admin", adminRoutes);

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api")) {
			return app.fetch(request, env, ctx);
		}
		if (url.pathname === "/") {
			return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
		}
		let res = await env.ASSETS.fetch(request);
		if (res.status === 404) {
			const p = url.pathname;
			const last = p.split("/").pop();
			const tries = [];
			if (p.endsWith("/")) tries.push(`${p}index.html`);
			else if (!last.includes(".")) tries.push(`${p}.html`, `${p}/index.html`);
			for (const t of tries) {
				const r2 = await env.ASSETS.fetch(new Request(new URL(t, url), request));
				if (r2.ok) return r2;
			}
		}
		return res;
	},
	async scheduled(event, env, ctx) {
		ctx.waitUntil(
			(async () => {
				const { tickSessions } = await import("./sessions.js");
				await tickSessions(env);
			})()
		);
	}
};
