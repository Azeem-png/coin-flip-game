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
		return env.ASSETS.fetch(request);
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
