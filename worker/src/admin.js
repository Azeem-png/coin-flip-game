import { Hono } from "hono";
import { first, all, run, now, uid, atomicAddBalance, balCol, getSettings, getUserPublic, toPublicUser, toGame, toTransaction } from "./db.js";
import { protect, adminAuth } from "./middleware.js";
import { autoExpireWithdrawals } from "./wallet.js";
import { getCurrentSession, createNewSession, manualResolve, settleGame, ensureActiveSession } from "./sessions.js";
import { hashPassword } from "./util.js";

const admin = new Hono();
admin.use("*", protect, adminAuth);

const SETTING_MAP = {
	commissionPercent: "commission_percent",
	minDeposit: "min_deposit",
	minWithdrawal: "min_withdrawal",
	minBet: "min_bet",
	maxBet: "max_bet",
	referralCommissionPercent: "referral_commission_percent",
	referralBonusEnabled: "referral_bonus_enabled",
	maintenanceMode: "maintenance_mode",
	maintenanceMessage: "maintenance_message",
	defaultCurrency: "default_currency",
	supportedCurrencies: "supported_currencies",
	exchangeRates: "exchange_rates",
	freeManualDraw: "free_manual_draw",
	announcement: "announcement",
	announcementEnabled: "announcement_enabled",
	autoResolve: "auto_resolve",
	autoCommission: "auto_commission"
};
const BOOL_COLS = new Set(["referral_bonus_enabled", "maintenance_mode", "free_manual_draw", "announcement_enabled", "auto_resolve", "auto_commission"]);

admin.get("/dashboard", async (c) => {
	try {
		const db = c.env.DB;
		await autoExpireWithdrawals(db);
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		const q = async (sql, p = []) => (await first(db, sql, p)) || {};
		const totalUsers = (await q(`SELECT COUNT(*) AS n FROM users WHERE role = 'user'`)).n || 0;
		const activeUsers = (await q(`SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND status = 'active'`)).n || 0;
		const totalGames = (await q(`SELECT COUNT(*) AS n FROM game_history`)).n || 0;
		const todayGames = (await q(`SELECT COUNT(*) AS n FROM game_history WHERE created_at >= ?`, [startOfDay.getTime()])).n || 0;
		const pendingDeposits = (await q(`SELECT COUNT(*) AS n FROM transactions WHERE type = 'deposit' AND status = 'pending'`)).n || 0;
		const pendingWithdrawals = (await q(`SELECT COUNT(*) AS n FROM transactions WHERE type = 'withdrawal' AND status = 'pending'`)).n || 0;
		const revenue = (await q(`SELECT SUM(amount) AS t FROM transactions WHERE type IN ('game_loss','game_commission') AND status = 'completed'`)).t || 0;
		const deposits = (await q(`SELECT SUM(amount) AS t FROM transactions WHERE type = 'deposit' AND status = 'approved'`)).t || 0;
		const withdrawals = (await q(`SELECT SUM(amount) AS t FROM transactions WHERE type = 'withdrawal' AND status = 'approved'`)).t || 0;
		const settings = await getSettings(db);
		const recent = await all(
			db,
			`SELECT t.*, u.name AS u_name, u.email AS u_email FROM transactions t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 10`
		);
		return c.json({
			success: true,
			stats: {
				totalUsers,
				activeUsers,
				totalGames,
				todayGames,
				pendingDeposits,
				pendingWithdrawals,
				totalRevenue: revenue,
				totalDeposits: deposits,
				totalWithdrawals: withdrawals,
				platformBalance: settings.platform_balance,
				platformTotalEarnings: settings.platform_total_earnings
			},
			settings: {
				commissionPercent: settings.commission_percent,
				maintenanceMode: settings.maintenanceMode,
				freeManualDraw: settings.freeManualDraw
			},
			recentActivity: recent.map(toTransaction)
		});
	} catch (err) {
		console.error("admin dashboard error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

const ADMIN_PUBLIC_COLS = `id, name, email, phone, role, status, bal_inr, bal_usd, bal_eur, bal_gbp, preferred_currency,
	referral_code, referred_by, referral_earnings, total_games, total_wins, total_losses, total_wagered,
	free_games, free_wins, free_losses, real_games, real_wins, real_losses, real_wagered,
	is_email_verified, last_login, token_version, created_at`;

admin.get("/users", async (c) => {
	try {
		const page = parseInt(c.req.query("page")) || 1;
		const limit = parseInt(c.req.query("limit")) || 20;
		const offset = (page - 1) * limit;
		const search = c.req.query("search");
		const status = c.req.query("status");
		const db = c.env.DB;
		const conds = [`role = 'user'`];
		const params = [];
		if (search) {
			conds.push(`(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`);
			const like = `%${String(search).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
			params.push(like, like, like);
		}
		if (status) {
			conds.push(`status = ?`);
			params.push(status);
		}
		const where = conds.join(" AND ");
		const rows = await all(db, `SELECT ${ADMIN_PUBLIC_COLS} FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
		const t = await first(db, `SELECT COUNT(*) AS n FROM users WHERE ${where}`, params);
		return c.json({ success: true, users: rows.map(toPublicUser), total: t.n, page, pages: Math.ceil(t.n / limit) });
	} catch (err) {
		console.error("admin users error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/users/:id", async (c) => {
	try {
		const db = c.env.DB;
		const row = await first(db, `SELECT ${ADMIN_PUBLIC_COLS} FROM users WHERE id = ?`, [c.req.param("id")]);
		if (!row) return c.json({ success: false, message: "User not found" }, 404);
		const transactions = await all(db, `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [row.id]);
		const games = await all(db, `SELECT * FROM game_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [row.id]);
		const referrals = await all(db, `SELECT name, email, created_at FROM users WHERE referred_by = ?`, [row.id]);
		return c.json({
			success: true,
			user: toPublicUser(row),
			transactions: transactions.map(toTransaction),
			gameHistory: games.map(toGame),
			referrals: referrals.map((r) => ({ name: r.name, email: r.email, createdAt: r.created_at }))
		});
	} catch (err) {
		console.error("admin user detail error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.patch("/users/:id", async (c) => {
	try {
		const { status, role, balanceAdjust, balanceCurrency, balanceNote } = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		const user = await first(db, `SELECT * FROM users WHERE id = ?`, [c.req.param("id")]);
		if (!user) return c.json({ success: false, message: "User not found" }, 404);
		if (status) await run(db, `UPDATE users SET status = ? WHERE id = ?`, [status, user.id]);
		if (role) await run(db, `UPDATE users SET role = ? WHERE id = ?`, [role, user.id]);
		if (balanceAdjust && balanceCurrency) {
			const col = balCol(balanceCurrency);
			await run(db, `UPDATE users SET ${col} = MAX(0, ${col} + ?) WHERE id = ?`, [Number(balanceAdjust), user.id]);
			await run(
				db,
				`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, admin_note, approved_by, created_at)
				 VALUES (?, ?, ?, ?, ?, 'completed', 'system', ?, ?, ?)`,
				[uid(), user.id, Number(balanceAdjust) > 0 ? "manual_credit" : "manual_debit", Math.abs(Number(balanceAdjust)), balanceCurrency, balanceNote || "Admin adjustment", c.get("user").id, now()]
			);
		}
		const updated = await getUserPublic(db, user.id);
		return c.json({ success: true, message: "User updated", user: updated });
	} catch (err) {
		console.error("admin update user error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/transactions", async (c) => {
	try {
		const db = c.env.DB;
		await autoExpireWithdrawals(db);
		const page = parseInt(c.req.query("page")) || 1;
		const limit = parseInt(c.req.query("limit")) || 20;
		const offset = (page - 1) * limit;
		const type = c.req.query("type");
		const status = c.req.query("status");
		const conds = [];
		const params = [];
		if (type) {
			conds.push(`t.type = ?`);
			params.push(type);
		}
		if (status) {
			conds.push(`t.status = ?`);
			params.push(status);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		const rows = await all(
			db,
			`SELECT t.*, u.name AS u_name, u.email AS u_email, u.phone AS u_phone, a.name AS a_name
			 FROM transactions t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.approved_by
			 ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);
		const t = await first(db, `SELECT COUNT(*) AS n FROM transactions t ${where}`, params);
		return c.json({ success: true, transactions: rows.map(toTransaction), total: t.n, page, pages: Math.ceil(t.n / limit) });
	} catch (err) {
		console.error("admin transactions error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.patch("/transactions/:id/approve", async (c) => {
	try {
		const { adminNote } = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		const tx = await first(db, `SELECT * FROM transactions WHERE id = ?`, [c.req.param("id")]);
		if (!tx) return c.json({ success: false, message: "Transaction not found" }, 404);
		if (tx.status !== "pending") return c.json({ success: false, message: "Transaction already processed" }, 400);
		const user = await first(db, `SELECT id FROM users WHERE id = ?`, [tx.user_id]);
		if (!user) return c.json({ success: false, message: "User not found" }, 404);
		if (tx.type === "deposit") {
			await atomicAddBalance(db, tx.user_id, tx.currency || "INR", tx.amount);
		}
		await run(db, `UPDATE transactions SET status = 'approved', admin_note = ?, approved_by = ?, processed_at = ? WHERE id = ?`, [
			adminNote || "",
			c.get("user").id,
			now(),
			tx.id
		]);
		const updated = await first(db, `SELECT * FROM transactions WHERE id = ?`, [tx.id]);
		return c.json({ success: true, message: "Transaction approved", transaction: toTransaction(updated) });
	} catch (err) {
		console.error("admin approve error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.patch("/transactions/:id/reject", async (c) => {
	try {
		const { adminNote } = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		const tx = await first(db, `SELECT * FROM transactions WHERE id = ?`, [c.req.param("id")]);
		if (!tx) return c.json({ success: false, message: "Transaction not found" }, 404);
		if (tx.status !== "pending") return c.json({ success: false, message: "Transaction already processed" }, 400);
		if (tx.type === "withdrawal") {
			await atomicAddBalance(db, tx.user_id, tx.currency || "INR", tx.amount);
		}
		await run(db, `UPDATE transactions SET status = 'rejected', admin_note = ?, approved_by = ?, processed_at = ? WHERE id = ?`, [
			adminNote || "",
			c.get("user").id,
			now(),
			tx.id
		]);
		const updated = await first(db, `SELECT * FROM transactions WHERE id = ?`, [tx.id]);
		return c.json({ success: true, message: "Transaction rejected", transaction: toTransaction(updated) });
	} catch (err) {
		console.error("admin reject error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/settings", async (c) => {
	try {
		return c.json({ success: true, settings: await getSettings(c.env.DB) });
	} catch (err) {
		console.error("admin settings error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.patch("/settings", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const db = c.env.DB;
		if (body.supportedCurrencies && !Array.isArray(body.supportedCurrencies)) {
			return c.json({ success: false, message: "supportedCurrencies must be an array" }, 400);
		}
		const sets = [];
		const params = [];
		for (const [camel, col] of Object.entries(SETTING_MAP)) {
			if (body[camel] !== undefined) {
				let v = body[camel];
				if (col === "supported_currencies" || col === "exchange_rates") v = JSON.stringify(v);
				else if (BOOL_COLS.has(col)) v = v ? 1 : 0;
				sets.push(`${col} = ?`);
				params.push(v);
			}
		}
		if (sets.length) {
			await run(db, `UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, params);
		}
		// Clamps (same as Express version)
		await run(
			db,
			`UPDATE settings SET commission_percent = MIN(100, MAX(0, commission_percent)),
			 min_bet = MAX(0, min_bet), max_bet = MAX(max_bet, min_bet + 1),
			 referral_commission_percent = MIN(100, MAX(0, referral_commission_percent)) WHERE id = 1`
		);
		const settings = await getSettings(db);
		if (body.defaultCurrency && !settings.supportedCurrencies.includes(body.defaultCurrency)) {
			return c.json({ success: false, message: "defaultCurrency must be in supportedCurrencies" }, 400);
		}
		return c.json({ success: true, message: "Settings updated", settings });
	} catch (err) {
		console.error("admin update settings error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/game-history", async (c) => {
	try {
		const page = parseInt(c.req.query("page")) || 1;
		const limit = parseInt(c.req.query("limit")) || 20;
		const offset = (page - 1) * limit;
		const userId = c.req.query("userId");
		const db = c.env.DB;
		const where = userId ? `WHERE g.user_id = ?` : "";
		const params = userId ? [userId] : [];
		const rows = await all(
			db,
			`SELECT g.*, u.name AS u_name, u.email AS u_email FROM game_history g LEFT JOIN users u ON u.id = g.user_id
			 ${where} ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);
		const t = await first(db, `SELECT COUNT(*) AS n FROM game_history g ${where}`, params);
		return c.json({ success: true, history: rows.map(toGame), total: t.n, page, pages: Math.ceil(t.n / limit) });
	} catch (err) {
		console.error("admin game-history error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/create-admin", async (c) => {
	try {
		const { name, email, phone, password, secret } = await c.req.json().catch(() => ({}));
		if (secret !== c.env.ADMIN_SECRET) return c.json({ success: false, message: "Invalid secret" }, 403);
		const db = c.env.DB;
		const existing = await first(db, `SELECT id FROM users WHERE email = ?`, [String(email).toLowerCase()]);
		if (existing) {
			await run(db, `UPDATE users SET role = 'admin' WHERE id = ?`, [existing.id]);
			return c.json({ success: true, message: "User promoted to admin" });
		}
		const id = uid();
		await run(
			db,
			`INSERT INTO users (id, name, email, phone, password, role, is_email_verified, status, referral_code, created_at)
			 VALUES (?, ?, ?, ?, ?, 'admin', 1, 'active', ?, ?)`,
			[id, name, String(email).toLowerCase(), phone || "", await hashPassword(password), randomUUID8(), now()]
		);
		return c.json({ success: true, message: "Admin created", adminId: id }, 201);
	} catch (err) {
		console.error("admin create-admin error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

function randomUUID8() {
	return "xxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)).toUpperCase();
}

admin.get("/pending-flips", async (c) => {
	try {
		const rows = await all(
			c.env.DB,
			`SELECT g.*, u.name AS u_name, u.email AS u_email FROM game_history g LEFT JOIN users u ON u.id = g.user_id
			 WHERE g.status = 'pending' ORDER BY g.created_at DESC`
		);
		const pending = rows.map(toGame);
		const real = pending.filter((g) => g.mode === "real");
		const free = pending.filter((g) => g.mode === "free");
		const heads = real.filter((g) => g.selectedSide === "heads");
		const tails = real.filter((g) => g.selectedSide === "tails");
		const sum = (arr) => arr.reduce((s, g) => s + g.betAmount, 0);
		return c.json({
			success: true,
			pending,
			stats: {
				headsTotal: sum(heads),
				tailsTotal: sum(tails),
				headsCount: heads.length + free.filter((g) => g.selectedSide === "heads").length,
				tailsCount: tails.length + free.filter((g) => g.selectedSide === "tails").length,
				totalBets: pending.length,
				totalAmount: sum(heads) + sum(tails),
				freeHeadsCount: free.filter((g) => g.selectedSide === "heads").length,
				freeTailsCount: free.filter((g) => g.selectedSide === "tails").length,
				realHeadsCount: heads.length,
				realTailsCount: tails.length
			}
		});
	} catch (err) {
		console.error("admin pending-flips error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/resolve-flips", async (c) => {
	try {
		const { result } = await c.req.json().catch(() => ({}));
		if (!["heads", "tails"].includes(result)) return c.json({ success: false, message: "Result must be heads or tails" }, 400);
		const db = c.env.DB;
		const settings = await getSettings(db);
		const session = await getCurrentSession(db);
		if (!session) return c.json({ success: false, message: "No active session" }, 400);
		const pending = await all(db, `SELECT * FROM game_history WHERE session_id = ? AND status = 'pending' AND mode = 'real'`, [String(session.session_id)]);
		if (!pending.length) return c.json({ success: true, message: "No pending flips in current session", resolved: 0 });
		let resolved = 0;
		for (const g of pending) {
			await settleGame(db, settings, g, result, true);
			resolved++;
		}
		return c.json({ success: true, message: `Resolved ${resolved} flips`, resolved, result });
	} catch (err) {
		console.error("admin resolve-flips error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/pending-free-flips", async (c) => {
	try {
		const rows = await all(
			c.env.DB,
			`SELECT g.*, u.name AS u_name, u.email AS u_email FROM game_history g LEFT JOIN users u ON u.id = g.user_id
			 WHERE g.mode = 'free' AND g.status = 'pending' ORDER BY g.created_at DESC`
		);
		const pending = rows.map(toGame);
		return c.json({
			success: true,
			pending,
			stats: { total: pending.length, headsCount: pending.filter((g) => g.selectedSide === "heads").length, tailsCount: pending.filter((g) => g.selectedSide === "tails").length }
		});
	} catch (err) {
		console.error("admin pending-free error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/resolve-free-flips", async (c) => {
	try {
		const { result } = await c.req.json().catch(() => ({}));
		if (!["heads", "tails"].includes(result)) return c.json({ success: false, message: "Result must be heads or tails" }, 400);
		const db = c.env.DB;
		const settings = await getSettings(db);
		const pending = await all(db, `SELECT * FROM game_history WHERE mode = 'free' AND status = 'pending'`);
		if (!pending.length) return c.json({ success: true, message: "No pending free flips", resolved: 0 });
		let resolved = 0;
		for (const g of pending) {
			await settleGame(db, settings, g, result, false);
			resolved++;
		}
		return c.json({ success: true, message: `Resolved ${resolved} free flips`, resolved, result });
	} catch (err) {
		console.error("admin resolve-free error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/session-status", async (c) => {
	try {
		const db = c.env.DB;
		// Advance expired rounds on read so the countdown stays live (no always-on timer).
		await ensureActiveSession(db);
		const session = await getCurrentSession(db);
		if (!session) return c.json({ success: true, active: false, message: "No active session" });
		const remaining = Math.max(0, Math.ceil((session.end_time - now()) / 1000));
		const rows = await all(
			db,
			`SELECT g.*, u.name AS u_name, u.email AS u_email FROM game_history g LEFT JOIN users u ON u.id = g.user_id
			 WHERE g.session_id = ? AND g.status = 'pending'`,
			[String(session.session_id)]
		);
		const pending = rows.map(toGame);
		const real = pending.filter((g) => g.mode === "real");
		const free = pending.filter((g) => g.mode === "free");
		const heads = real.filter((g) => g.selectedSide === "heads");
		const tails = real.filter((g) => g.selectedSide === "tails");
		return c.json({
			success: true,
			active: true,
			session: {
				sessionId: session.session_id,
				startTime: session.start_time,
				endTime: session.end_time,
				remaining,
				adminSetResult: session.admin_set_result,
				status: session.status
			},
			pending: pending.map((g) => ({ _id: g._id, userId: g.userId, mode: g.mode, selectedSide: g.selectedSide, betAmount: g.betAmount, currency: g.currency })),
			stats: {
				totalBets: pending.length,
				realBets: real.length,
				freeBets: free.length,
				headsAmount: heads.reduce((s, g) => s + g.betAmount, 0),
				tailsAmount: tails.reduce((s, g) => s + g.betAmount, 0),
				headsCount: heads.length,
				tailsCount: tails.length,
				freeHeadsCount: free.filter((g) => g.selectedSide === "heads").length,
				freeTailsCount: free.filter((g) => g.selectedSide === "tails").length
			}
		});
	} catch (err) {
		console.error("admin session-status error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/session-result", async (c) => {
	try {
		const { result } = await c.req.json().catch(() => ({}));
		if (!["heads", "tails", null].includes(result)) return c.json({ success: false, message: "Result must be heads, tails, or null" }, 400);
		const db = c.env.DB;
		const session = await getCurrentSession(db);
		if (!session) return c.json({ success: false, message: "No active session" }, 400);
		if (session.status === "ended") return c.json({ success: false, message: "Current session has already ended, wait for the next round" }, 400);
		await run(db, `UPDATE game_sessions SET admin_set_result = ? WHERE session_id = ?`, [result, session.session_id]);
		return c.json({
			success: true,
			message: result ? `Next round result set to ${result.toUpperCase()}` : "Result cleared — will use auto-random",
			adminSetResult: result,
			sessionId: session.session_id
		});
	} catch (err) {
		console.error("admin session-result error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/platform-wallet", async (c) => {
	try {
		const db = c.env.DB;
		const settings = await getSettings(db);
		const rows = await all(db, `SELECT * FROM transactions WHERE type = 'platform_withdrawal' ORDER BY created_at DESC LIMIT 50`);
		return c.json({ success: true, balance: settings.platform_balance, totalEarnings: settings.platform_total_earnings, withdrawals: rows.map(toTransaction) });
	} catch (err) {
		console.error("admin platform-wallet error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/platform-withdraw", async (c) => {
	try {
		const { amount, method, details } = await c.req.json().catch(() => ({}));
		const num = Number(amount);
		if (isNaN(num) || num <= 0) return c.json({ success: false, message: "Invalid amount" }, 400);
		const db = c.env.DB;
		const settings = await getSettings(db);
		if (num > settings.platform_balance) return c.json({ success: false, message: "Insufficient platform balance" }, 400);
		await run(db, `UPDATE settings SET platform_balance = platform_balance - ? WHERE id = 1`, [num]);
		await run(
			db,
			`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, admin_note, created_at)
			 VALUES (?, ?, 'platform_withdrawal', ?, 'INR', 'completed', ?, ?, ?)`,
			[uid(), c.get("user").id, num, method || "bank_transfer", `${details || ""} (${method || "N/A"})`, now()]
		);
		const s2 = await getSettings(db);
		return c.json({ success: true, message: `Withdrawal of ₹${num} successful`, balance: s2.platform_balance });
	} catch (err) {
		console.error("admin platform-withdraw error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/resolve-now", async (c) => {
	try {
		const db = c.env.DB;
		const session = await getCurrentSession(db);
		if (!session || session.status === "ended") return c.json({ success: false, message: "No active session to resolve" }, 400);
		if (await manualResolve(db)) return c.json({ success: true, message: "Session resolved manually" });
		return c.json({ success: false, message: "Session is already resolving, try again" }, 409);
	} catch (err) {
		console.error("admin resolve-now error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/auto-resolve", async (c) => {
	try {
		const s = await getSettings(c.env.DB);
		return c.json({ success: true, autoResolve: s.autoResolve });
	} catch (err) {
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/auto-resolve", async (c) => {
	try {
		const { enabled } = await c.req.json().catch(() => ({}));
		await run(c.env.DB, `UPDATE settings SET auto_resolve = ? WHERE id = 1`, [enabled !== false ? 1 : 0]);
		return c.json({ success: true, autoResolve: enabled !== false, message: enabled ? "Auto-resolve ON" : "Auto-resolve OFF — use Resolve Now manually" });
	} catch (err) {
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.get("/auto-commission", async (c) => {
	try {
		const s = await getSettings(c.env.DB);
		return c.json({ success: true, autoCommission: s.autoCommission });
	} catch (err) {
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

admin.post("/auto-commission", async (c) => {
	try {
		const { enabled } = await c.req.json().catch(() => ({}));
		await run(c.env.DB, `UPDATE settings SET auto_commission = ? WHERE id = 1`, [enabled === true ? 1 : 0]);
		return c.json({ success: true, autoCommission: enabled === true, message: enabled ? "Auto-Commission ON — house always wins" : "Auto-Commission OFF" });
	} catch (err) {
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

export default admin;
