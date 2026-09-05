import { randomUUID } from "node:crypto";

export const now = () => Date.now();
export const uid = () => randomUUID().replace(/-/g, "").slice(0, 24);

export async function first(db, sql, params = []) {
	return db.prepare(sql).bind(...params).first();
}

export async function all(db, sql, params = []) {
	const { results } = await db.prepare(sql).bind(...params).all();
	return results || [];
}

export async function run(db, sql, params = []) {
	return db.prepare(sql).bind(...params).run();
}

const BAL_COLS = { INR: "bal_inr", USD: "bal_usd", EUR: "bal_eur", GBP: "bal_gbp" };
export function balCol(currency) {
	const col = BAL_COLS[String(currency || "INR").toUpperCase()];
	if (!col) throw new Error("UNSUPPORTED_CURRENCY");
	return col;
}

const PUBLIC_USER_COLS = `id, name, email, phone, role, status,
  bal_inr, bal_usd, bal_eur, bal_gbp, preferred_currency,
  referral_code, referred_by, referral_earnings,
  total_games, total_wins, total_losses, total_wagered,
  free_games, free_wins, free_losses, real_games, real_wins, real_losses, real_wagered,
  is_email_verified, last_login, token_version, created_at`;

export function toPublicUser(row) {
	if (!row) return null;
	return {
		_id: row.id,
		id: row.id,
		name: row.name,
		email: row.email,
		phone: row.phone,
		role: row.role,
		status: row.status,
		balance: { INR: row.bal_inr, USD: row.bal_usd, EUR: row.bal_eur, GBP: row.bal_gbp },
		preferredCurrency: row.preferred_currency,
		referralCode: row.referral_code,
		referredBy: row.referred_by,
		referralEarnings: row.referral_earnings,
		totalGames: row.total_games,
		totalWins: row.total_wins,
		totalLosses: row.total_losses,
		totalWagered: row.total_wagered,
		freeGames: row.free_games,
		freeWins: row.free_wins,
		freeLosses: row.free_losses,
		realGames: row.real_games,
		realWins: row.real_wins,
		realLosses: row.real_losses,
		realWagered: row.real_wagered,
		isEmailVerified: !!row.is_email_verified,
		lastLogin: row.last_login,
		createdAt: row.created_at
	};
}

export async function atomicAddBalance(db, userId, currency, amount) {
	const col = balCol(currency);
	await run(db, `UPDATE users SET ${col} = ${col} + ? WHERE id = ?`, [amount, userId]);
	const r = await first(db, `SELECT ${col} AS b FROM users WHERE id = ?`, [userId]);
	return r ? r.b : null;
}

export async function atomicDeductBalance(db, userId, currency, amount) {
	const col = balCol(currency);
	const res = await run(db, `UPDATE users SET ${col} = ${col} - ? WHERE id = ? AND ${col} >= ?`, [amount, userId, amount]);
	if (!res.meta || !res.meta.changes) return null;
	const r = await first(db, `SELECT ${col} AS b FROM users WHERE id = ?`, [userId]);
	return r ? r.b : null;
}

export function toGame(row) {
	if (!row) return null;
	const g = {
		_id: row.id,
		id: row.id,
		userId: row.user_id,
		mode: row.mode,
		betAmount: row.bet_amount,
		currency: row.currency,
		selectedSide: row.selected_side,
		result: row.result,
		outcome: row.outcome,
		status: row.status,
		commission: row.commission,
		netPayout: row.net_payout,
		adminForced: !!row.admin_forced,
		balanceBefore: row.balance_before,
		balanceAfter: row.balance_after,
		sessionId: row.session_id,
		createdAt: row.created_at
	};
	if (row.u_name !== undefined) {
		g.userId = { _id: row.user_id, name: row.u_name, email: row.u_email };
		if (row.u_phone !== undefined) g.userId.phone = row.u_phone;
	}
	return g;
}

export function toTransaction(row) {
	if (!row) return null;
	let details = {};
	try {
		details = row.payment_details ? JSON.parse(row.payment_details) : {};
	} catch {
		details = {};
	}
	const t = {
		_id: row.id,
		id: row.id,
		userId: row.user_id,
		type: row.type,
		amount: row.amount,
		currency: row.currency,
		status: row.status,
		paymentMethod: row.payment_method,
		paymentDetails: details,
		adminNote: row.admin_note,
		approvedBy: row.approved_by,
		processedAt: row.processed_at,
		createdAt: row.created_at
	};
	if (row.u_name !== undefined) {
		t.userId = { _id: row.user_id, name: row.u_name, email: row.u_email };
		if (row.u_phone !== undefined) t.userId.phone = row.u_phone;
	}
	if (row.a_name !== undefined && row.approved_by) {
		t.approvedBy = { _id: row.approved_by, name: row.a_name };
	}
	return t;
}

export async function getUserPublic(db, id) {
	const row = await first(db, `SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`, [id]);
	return toPublicUser(row);
}

export async function getSettings(db) {
	let s = await first(db, `SELECT * FROM settings WHERE id = 1`);
	if (!s) {
		await run(db, `INSERT INTO settings (id) VALUES (1)`);
		s = await first(db, `SELECT * FROM settings WHERE id = 1`);
	}
	return {
		...s,
		commissionPercent: s.commission_percent,
		minBet: s.min_bet,
		maxBet: s.max_bet,
		minDeposit: s.min_deposit,
		minWithdrawal: s.min_withdrawal,
		sessionDuration: s.session_duration,
		referralCommissionPercent: s.referral_commission_percent,
		platformBalance: s.platform_balance,
		platformTotalEarnings: s.platform_total_earnings,
		announcement: s.announcement,
		maintenanceMessage: s.maintenance_message,
		defaultCurrency: s.default_currency,
		supportedCurrencies: JSON.parse(s.supported_currencies || "[]"),
		exchangeRates: JSON.parse(s.exchange_rates || "{}"),
		maintenanceMode: !!s.maintenance_mode,
		announcementEnabled: !!s.announcement_enabled,
		manualDraw: !!s.manual_draw,
		freeManualDraw: !!s.free_manual_draw,
		autoResolve: s.auto_resolve !== 0,
		autoCommission: s.auto_commission !== 0,
		referralBonusEnabled: s.referral_bonus_enabled !== 0
	};
}
