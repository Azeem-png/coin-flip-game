import { first, all, run, now, uid, balCol, atomicAddBalance, getSettings } from "./db.js";

export function pickSide() {
	return crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? "heads" : "tails";
}

function randomSessionId() {
	const chars = "ABCDEF0123456789";
	const b = crypto.getRandomValues(new Uint8Array(12));
	return [...b].map((x) => chars[x % chars.length]).join("");
}

export async function getCurrentSession(db) {
	return first(db, `SELECT * FROM game_sessions WHERE status = 'betting' ORDER BY start_time DESC LIMIT 1`);
}

export async function createNewSession(db, settings) {
	const duration = Number(settings.session_duration) || 10;
	const start = now();
	const sid = randomSessionId();
	await run(db, `INSERT INTO game_sessions (id, session_id, start_time, end_time, status) VALUES (?, ?, ?, ?, 'betting')`, [
		uid(),
		sid,
		start,
		start + duration * 1000
	]);
	return first(db, `SELECT * FROM game_sessions WHERE session_id = ?`, [sid]);
}

// Lazy session getter: resolves expired rounds on demand (no always-on timer needed).
export async function ensureActiveSession(db) {
	const settings = await getSettings(db);
	let s = await getCurrentSession(db);
	if (!s) return createNewSession(db, settings);
	if (s.end_time <= now() && settings.autoResolve) {
		await resolveSession(db, s);
		return createNewSession(db, await getSettings(db));
	}
	return s;
}

export async function settleGame(db, settings, game, result, adminForced) {
	const outcome = game.selected_side === result ? "win" : "loss";
	const user = await first(db, `SELECT * FROM users WHERE id = ?`, [game.user_id]);
	if (!user) return;
	const cur = game.currency || "INR";
	let netPayout = 0;
	let commission = 0;

	if (game.mode === "real") {
		if (outcome === "win") {
			commission = (game.bet_amount * settings.commission_percent) / 100;
			netPayout = game.bet_amount - commission;
			const balAfter = await atomicAddBalance(db, game.user_id, cur, netPayout + game.bet_amount);
			await run(db, `UPDATE settings SET platform_balance = platform_balance + ?, platform_total_earnings = platform_total_earnings + ? WHERE id = 1`, [
				commission,
				commission
			]);
			await run(db, `UPDATE game_history SET balance_after = ? WHERE id = ?`, [balAfter, game.id]);
		} else {
			await run(db, `UPDATE settings SET platform_balance = platform_balance + ?, platform_total_earnings = platform_total_earnings + ? WHERE id = 1`, [
				game.bet_amount,
				game.bet_amount
			]);
			const col = balCol(cur);
			const urow = await first(db, `SELECT ${col} AS b FROM users WHERE id = ?`, [game.user_id]);
			await run(db, `UPDATE game_history SET balance_after = ? WHERE id = ?`, [urow ? urow.b : 0, game.id]);
		}
		await run(
			db,
			`UPDATE users SET total_wins = total_wins + ?, total_losses = total_losses + ?, total_games = total_games + 1,
			 total_wagered = total_wagered + ?, real_games = real_games + 1, real_wagered = real_wagered + ?,
			 real_wins = real_wins + ?, real_losses = real_losses + ? WHERE id = ?`,
			[
				outcome === "win" ? 1 : 0,
				outcome === "win" ? 0 : 1,
				game.bet_amount,
				game.bet_amount,
				outcome === "win" ? 1 : 0,
				outcome === "win" ? 0 : 1,
				game.user_id
			]
		);
	} else {
		await run(
			db,
			`UPDATE users SET total_wins = total_wins + ?, total_losses = total_losses + ?, total_games = total_games + 1,
			 free_games = free_games + 1, free_wins = free_wins + ?, free_losses = free_losses + ? WHERE id = ?`,
			[outcome === "win" ? 1 : 0, outcome === "win" ? 0 : 1, outcome === "win" ? 1 : 0, outcome === "win" ? 0 : 1, game.user_id]
		);
	}

	await run(db, `UPDATE game_history SET result = ?, outcome = ?, status = 'completed', admin_forced = ?, commission = ?, net_payout = ? WHERE id = ?`, [
		result,
		outcome,
		adminForced ? 1 : 0,
		commission,
		netPayout,
		game.id
	]);

	if (game.mode === "real") {
		await run(
			db,
			`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, created_at) VALUES (?, ?, ?, ?, ?, 'completed', 'system', ?)`,
			[uid(), game.user_id, outcome === "win" ? "game_win" : "game_loss", outcome === "win" ? netPayout : game.bet_amount, cur, now()]
		);
		if (outcome === "win" && user.referred_by && settings.referralBonusEnabled) {
			const bonus = (game.bet_amount * settings.referral_commission_percent) / 100;
			const referrer = await first(db, `SELECT id, status FROM users WHERE id = ?`, [user.referred_by]);
			if (referrer && referrer.status === "active") {
				await atomicAddBalance(db, user.referred_by, cur, bonus);
				await run(db, `UPDATE users SET referral_earnings = referral_earnings + ? WHERE id = ?`, [bonus, user.referred_by]);
				await run(
					db,
					`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, created_at) VALUES (?, ?, 'referral_bonus', ?, ?, 'completed', 'system', ?)`,
					[uid(), referrer.id, bonus, cur, now()]
				);
			}
		}
	}
}

// Claims + resolves one session. Returns true if this call resolved it.
export async function resolveSession(db, session, adminForced = false) {
	const claimed = await run(db, `UPDATE game_sessions SET status = 'ended' WHERE session_id = ? AND status = 'betting'`, [session.session_id]);
	if (!claimed.meta || !claimed.meta.changes) return false;
	const settings = await getSettings(db);
	const fresh = await first(db, `SELECT * FROM game_sessions WHERE session_id = ?`, [session.session_id]);
	const adminResult = fresh && fresh.admin_set_result;
	let result;
	let isAuto = false;
	if (adminResult === "heads" || adminResult === "tails") {
		result = adminResult;
	} else if (settings.autoCommission) {
		const pending = await all(db, `SELECT selected_side, bet_amount FROM game_history WHERE session_id = ? AND status = 'pending' AND mode = 'real'`, [
			session.session_id
		]);
		let heads = 0;
		let tails = 0;
		for (const g of pending) {
			if (g.selected_side === "heads") heads += g.bet_amount;
			else tails += g.bet_amount;
		}
		if (heads > tails) result = "tails";
		else if (tails > heads) result = "heads";
		else result = pickSide();
		isAuto = true;
	} else {
		result = pickSide();
		isAuto = true;
	}
	const pending = await all(db, `SELECT * FROM game_history WHERE session_id = ? AND status = 'pending'`, [session.session_id]);
	for (const g of pending) {
		await settleGame(db, settings, g, result, adminForced);
	}
	await run(db, `UPDATE game_sessions SET result = ?, is_auto = ?, admin_set_result = ?, end_time = ? WHERE session_id = ?`, [
		result,
		isAuto ? 1 : 0,
		adminResult || null,
		now(),
		session.session_id
	]);
	return true;
}

// Cron entry: resolve expired rounds, keep one active session ready.
export async function tickSessions(env) {
	const db = env.DB;
	const settings = await getSettings(db);
	const expired = await all(db, `SELECT * FROM game_sessions WHERE status = 'betting' AND end_time <= ?`, [now()]);
	let resolved = 0;
	if (settings.autoResolve) {
		for (const s of expired) {
			if (await resolveSession(db, s)) resolved++;
		}
	}
	const current = await getCurrentSession(db);
	if (!current) await createNewSession(db, settings);
	// Prune sessions ended over 7 days ago (history/transactions are kept).
	await run(db, `DELETE FROM game_sessions WHERE status = 'ended' AND end_time < ?`, [now() - 7 * 24 * 60 * 60 * 1000]);
	return { resolved };
}

export async function manualResolve(db) {
	const s = await getCurrentSession(db);
	if (!s || s.status === "ended") return false;
	await resolveSession(db, s);
	await createNewSession(db, await getSettings(db));
	return true;
}
