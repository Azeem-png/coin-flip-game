import { Hono } from "hono";
import { first, all } from "./db.js";
import { protect } from "./middleware.js";
import { toTransaction } from "./db.js";

const referral = new Hono();

referral.get("/my-code", protect, async (c) => {
	try {
		const user = await first(c.env.DB, `SELECT referral_code, referral_earnings FROM users WHERE id = ?`, [c.get("user").id]);
		const base = c.env.FRONTEND_URL || "http://localhost:5000";
		return c.json({
			success: true,
			referralCode: user.referral_code,
			referralLink: `${base}/register.html?ref=${user.referral_code}`,
			referralEarnings: user.referral_earnings
		});
	} catch (err) {
		console.error("referral my-code error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

referral.get("/stats", protect, async (c) => {
	try {
		const db = c.env.DB;
		const user = await first(db, `SELECT referral_code, referral_earnings FROM users WHERE id = ?`, [c.get("user").id]);
		const referred = await all(db, `SELECT name, email, created_at, total_games, total_wins FROM users WHERE referred_by = ?`, [c.get("user").id]);
		const bonuses = await all(db, `SELECT * FROM transactions WHERE user_id = ? AND type = 'referral_bonus' ORDER BY created_at DESC LIMIT 20`, [
			c.get("user").id
		]);
		return c.json({
			success: true,
			referralCode: user.referral_code,
			totalReferred: referred.length,
			totalEarnings: user.referral_earnings,
			referredUsers: referred.map((u) => ({ name: u.name, email: u.email, createdAt: u.created_at, totalGames: u.total_games, totalWins: u.total_wins })),
			recentBonuses: bonuses.map(toTransaction)
		});
	} catch (err) {
		console.error("referral stats error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

referral.get("/leaderboard", protect, async (c) => {
	try {
		const rows = await all(
			c.env.DB,
			`SELECT u.name AS name, u.referral_code AS referralCode, u.referral_earnings AS referralEarnings,
				COUNT(r.id) AS referralCount
			 FROM users u LEFT JOIN users r ON r.referred_by = u.id
			 WHERE u.role = 'user'
			 GROUP BY u.id ORDER BY referralCount DESC LIMIT 10`
		);
		return c.json({ success: true, leaderboard: rows });
	} catch (err) {
		console.error("referral leaderboard error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

export default referral;
