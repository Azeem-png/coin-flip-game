import { Hono } from "hono";
import { first, all, run, now, uid, balCol, atomicDeductBalance, getSettings, toGame } from "./db.js";
import { ensureActiveSession, pickSide } from "./sessions.js";
import { protect } from "./middleware.js";

const game = new Hono();

const flipMap = new Map();
let flipPrune = 0;
function checkFlipRate(userId, minInterval) {
	const t = now();
	if (t - flipPrune > 60000) {
		flipPrune = t;
		const cutoff = t - 10000;
		for (const [k, v] of flipMap) if (v < cutoff) flipMap.delete(k);
	}
	const last = flipMap.get(String(userId)) || 0;
	if (t - last < minInterval) return false;
	flipMap.set(String(userId), t);
	return true;
}

game.post("/flip", protect, async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		let { selectedSide, betAmount, currency, mode } = body;
		if (typeof betAmount === "boolean" || (typeof betAmount === "object" && betAmount !== null)) betAmount = NaN;
		betAmount = Number(betAmount);
		if (isNaN(betAmount) || betAmount < 0) betAmount = 0;
		const db = c.env.DB;
		const settings = await getSettings(db);

		if (settings.maintenanceMode) {
			return c.json({ success: false, message: settings.maintenance_message }, 503);
		}
		if (!["heads", "tails"].includes(selectedSide)) {
			return c.json({ success: false, message: "Invalid selection. Choose heads or tails." }, 400);
		}

		// --- FREE MODE ---
		if (mode === "free") {
			if (!checkFlipRate(c.get("user").id, 1000)) {
				return c.json({ success: false, message: "Too fast! Wait a moment between free bets." }, 429);
			}
			if (settings.freeManualDraw) {
				const id = uid();
				await run(
					db,
					`INSERT INTO game_history (id, user_id, mode, bet_amount, currency, selected_side, status, outcome, created_at)
					 VALUES (?, ?, 'free', 0, ?, ?, 'pending', 'pending', ?)`,
					[id, c.get("user").id, currency || "INR", selectedSide, now()]
				);
				return c.json({ success: true, mode: "manual_draw", gameId: id, message: "Bet placed. Waiting for admin to declare result." });
			}
			const result = pickSide();
			const outcome = result === selectedSide ? "win" : "loss";
			await run(
				db,
				`INSERT INTO game_history (id, user_id, mode, bet_amount, currency, selected_side, result, outcome, status, created_at)
				 VALUES (?, ?, 'free', 0, ?, ?, ?, ?, 'completed', ?)`,
				[uid(), c.get("user").id, currency || "INR", selectedSide, result, outcome, now()]
			);
			await run(
				db,
				`UPDATE users SET free_games = free_games + 1, ${outcome === "win" ? "free_wins = free_wins + 1" : "free_losses = free_losses + 1"} WHERE id = ?`,
				[c.get("user").id]
			);
			return c.json({ success: true, result, outcome, mode: "free" });
		}

		// --- REAL MONEY MODE ---
		if (!checkFlipRate(c.get("user").id, 500)) {
			return c.json({ success: false, message: "Too fast! Wait a moment before placing another bet." }, 429);
		}
		if (betAmount <= 0) return c.json({ success: false, message: "Invalid bet amount" }, 400);
		if (betAmount < settings.min_bet) return c.json({ success: false, message: `Minimum bet is ₹${settings.min_bet}` }, 400);
		if (betAmount > settings.max_bet) return c.json({ success: false, message: `Maximum bet is ₹${settings.max_bet}` }, 400);

		const me = await first(db, `SELECT * FROM users WHERE id = ?`, [c.get("user").id]);
		const cur = currency || me.preferred_currency || "INR";
		const supported = settings.supportedCurrencies && settings.supportedCurrencies.length ? settings.supportedCurrencies : ["INR", "USD", "EUR", "GBP"];
		if (!supported.includes(cur)) return c.json({ success: false, message: `Unsupported currency: ${cur}` }, 400);

		const col = balCol(cur);
		const balRow = await first(db, `SELECT ${col} AS b FROM users WHERE id = ?`, [me.id]);
		const userBalance = balRow ? balRow.b : 0;
		if (userBalance < betAmount) {
			return c.json({ success: false, message: `Insufficient balance. Your balance: ₹${Number(userBalance).toFixed(2)}` }, 400);
		}

		let session;
		try {
			session = await ensureActiveSession(db);
		} catch {
			return c.json({ success: false, message: "Game session unavailable. Please try again in a moment." }, 503);
		}
		if (!session || session.status !== "betting") {
			return c.json({ success: false, message: "No active game session. Please try again shortly." }, 503);
		}

		const gameId = uid();
		await run(
			db,
			`INSERT INTO game_history (id, user_id, mode, bet_amount, currency, selected_side, status, outcome, balance_before, session_id, created_at)
			 VALUES (?, ?, 'real', ?, ?, ?, 'pending', 'pending', ?, ?, ?)`,
			[gameId, me.id, betAmount, cur, selectedSide, userBalance, String(session.session_id), now()]
		);
		const newBal = await atomicDeductBalance(db, me.id, cur, betAmount);
		if (newBal === null) {
			await run(db, `UPDATE game_history SET status = 'cancelled' WHERE id = ?`, [gameId]);
			return c.json({ success: false, message: "Insufficient balance" }, 400);
		}
		await run(db, `UPDATE game_history SET balance_after = ? WHERE id = ?`, [newBal, gameId]);
		await run(
			db,
			`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, created_at) VALUES (?, ?, 'game_bet', ?, ?, 'completed', 'system', ?)`,
			[uid(), me.id, betAmount, cur, now()]
		);
		return c.json({ success: true, mode: "session_pending", gameId, message: "Bet placed. Waiting for round to complete.", balance: newBal, currency: cur });
	} catch (err) {
		console.error("flip error:", err.message);
		return c.json({ success: false, message: "Something went wrong. Please try again." }, 500);
	}
});

game.get("/pending-status/:gameId", protect, async (c) => {
	try {
		const db = c.env.DB;
		// Resolve-on-read: settle expired rounds so results arrive in ~2s, no timer wait.
		await ensureActiveSession(db);
		let g = await first(db, `SELECT * FROM game_history WHERE id = ?`, [c.req.param("gameId")]);
		if (!g) return c.json({ success: false, message: "Game not found" }, 404);
		if (String(g.user_id) !== String(c.get("user").id)) return c.json({ success: false, message: "Unauthorized" }, 403);

		if (g.status === "pending" && g.mode === "free" && g.created_at < now() - 60000) {
			const result = pickSide();
			const outcome = g.selected_side === result ? "win" : "loss";
			await run(
				db,
				`UPDATE users SET total_wins = total_wins + ?, total_losses = total_losses + ?, total_games = total_games + 1,
				 free_games = free_games + 1, free_wins = free_wins + ?, free_losses = free_losses + ? WHERE id = ?`,
				[outcome === "win" ? 1 : 0, outcome === "win" ? 0 : 1, outcome === "win" ? 1 : 0, outcome === "win" ? 0 : 1, g.user_id]
			);
			await run(db, `UPDATE game_history SET result = ?, outcome = ?, status = 'completed' WHERE id = ?`, [result, outcome, g.id]);
			g = await first(db, `SELECT * FROM game_history WHERE id = ?`, [g.id]);
		}
		return c.json({ success: true, status: g.status, game: toGame(g) });
	} catch (err) {
		console.error("pending-status error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

game.get("/check-pending", protect, async (c) => {
	try {
		const latest = await first(c.env.DB, `SELECT * FROM game_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [c.get("user").id]);
		if (!latest) return c.json({ success: true, hasPending: false, game: null });
		if (latest.status === "pending") return c.json({ success: true, hasPending: true, game: toGame(latest), mode: "pending" });
		if (latest.status === "completed" && latest.created_at > now() - 30000) {
			return c.json({ success: true, hasPending: true, game: toGame(latest), mode: "recent" });
		}
		return c.json({ success: true, hasPending: false, game: null });
	} catch (err) {
		console.error("check-pending error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

game.get("/history", protect, async (c) => {
	try {
		const page = parseInt(c.req.query("page")) || 1;
		const limit = parseInt(c.req.query("limit")) || 20;
		const offset = (page - 1) * limit;
		const db = c.env.DB;
		const rows = await all(db, `SELECT * FROM game_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`, [c.get("user").id, limit, offset]);
		const t = await first(db, `SELECT COUNT(*) AS n FROM game_history WHERE user_id = ?`, [c.get("user").id]);
		return c.json({ success: true, history: rows.map(toGame), total: t.n, page, pages: Math.ceil(t.n / limit) });
	} catch (err) {
		console.error("history error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

game.get("/stats", protect, async (c) => {
	try {
		const u = await first(c.env.DB, `SELECT * FROM users WHERE id = ?`, [c.get("user").id]);
		const mode = c.req.query("mode") || "all";
		let stats;
		if (mode === "free") {
			stats = {
				totalGames: u.free_games,
				totalWins: u.free_wins,
				totalLosses: u.free_losses,
				totalWagered: 0,
				winRate: u.free_games > 0 ? ((u.free_wins / u.free_games) * 100).toFixed(1) : 0
			};
		} else if (mode === "real") {
			stats = {
				totalGames: u.real_games,
				totalWins: u.real_wins,
				totalLosses: u.real_losses,
				totalWagered: u.real_wagered,
				winRate: u.real_games > 0 ? ((u.real_wins / u.real_games) * 100).toFixed(1) : 0
			};
		} else {
			stats = {
				totalGames: u.total_games,
				totalWins: u.total_wins,
				totalLosses: u.total_losses,
				totalWagered: u.total_wagered,
				winRate: u.total_games > 0 ? ((u.total_wins / u.total_games) * 100).toFixed(1) : 0
			};
		}
		return c.json({ success: true, stats });
	} catch (err) {
		console.error("stats error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

export default game;
