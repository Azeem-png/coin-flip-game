import { Hono } from "hono";
import { first, all, run, now, uid, atomicDeductBalance, atomicAddBalance, getSettings, toTransaction, toPublicUser } from "./db.js";
import { protect, requireVerified } from "./middleware.js";

const wallet = new Hono();

export async function autoExpireWithdrawals(db) {
	try {
		const cutoff = now() - 72 * 60 * 60 * 1000;
		const expired = await all(db, `SELECT * FROM transactions WHERE type = 'withdrawal' AND status = 'pending' AND created_at < ?`, [cutoff]);
		for (const t of expired) {
			await run(db, `UPDATE transactions SET status = 'rejected', admin_note = 'Auto-cancelled (exceeded 72h processing time)', processed_at = ? WHERE id = ?`, [
				now(),
				t.id
			]);
			await atomicAddBalance(db, t.user_id, t.currency || "INR", t.amount);
		}
		if (expired.length) console.log(`Auto-cancelled ${expired.length} stale withdrawal(s)`);
	} catch (err) {
		console.error("Withdrawal expiry check error:", err.message);
	}
}

wallet.post("/deposit", protect, requireVerified, async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		let amount = Number(body.amount);
		if (isNaN(amount) || amount < 0) amount = 0;
		const db = c.env.DB;
		const settings = await getSettings(db);
		const me = await first(db, `SELECT preferred_currency FROM users WHERE id = ?`, [c.get("user").id]);
		const cur = body.currency || (me && me.preferred_currency) || "INR";
		if (!amount || amount < settings.min_deposit) {
			return c.json({ success: false, message: `Minimum deposit is ₹${settings.min_deposit}` }, 400);
		}
		const id = uid();
		await run(
			db,
			`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, payment_details, created_at)
			 VALUES (?, ?, 'deposit', ?, ?, 'pending', ?, ?, ?)`,
			[id, c.get("user").id, amount, cur, body.paymentMethod || "UPI", JSON.stringify(body.paymentDetails || {}), now()]
		);
		return c.json({ success: true, message: "Deposit request submitted. Waiting for admin approval.", transactionId: id }, 201);
	} catch (err) {
		console.error("deposit error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

wallet.post("/withdraw", protect, requireVerified, async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		let amount = Number(body.amount);
		if (isNaN(amount) || amount < 0) amount = 0;
		const db = c.env.DB;
		const settings = await getSettings(db);
		const me = await first(db, `SELECT preferred_currency FROM users WHERE id = ?`, [c.get("user").id]);
		const cur = body.currency || (me && me.preferred_currency) || "INR";
		if (!amount || amount < settings.min_withdrawal) {
			return c.json({ success: false, message: `Minimum withdrawal is ₹${settings.min_withdrawal}` }, 400);
		}
		const newBal = await atomicDeductBalance(db, c.get("user").id, cur, amount);
		if (newBal === null) return c.json({ success: false, message: "Insufficient balance" }, 400);
		const id = uid();
		await run(
			db,
			`INSERT INTO transactions (id, user_id, type, amount, currency, status, payment_method, payment_details, created_at)
			 VALUES (?, ?, 'withdrawal', ?, ?, 'pending', ?, ?, ?)`,
			[id, c.get("user").id, amount, cur, body.paymentMethod || "UPI", JSON.stringify(body.paymentDetails || {}), now()]
		);
		return c.json({ success: true, message: "Withdrawal request submitted. Will be processed within 24 hours.", transactionId: id, newBalance: newBal }, 201);
	} catch (err) {
		console.error("withdraw error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

wallet.get("/transactions", protect, async (c) => {
	try {
		const db = c.env.DB;
		await autoExpireWithdrawals(db);
		const page = parseInt(c.req.query("page")) || 1;
		const limit = parseInt(c.req.query("limit")) || 20;
		const offset = (page - 1) * limit;
		const type = c.req.query("type");
		let where = `user_id = ?`;
		const params = [c.get("user").id];
		if (type) {
			where += ` AND type = ?`;
			params.push(type);
		}
		const rows = await all(db, `SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
		const t = await first(db, `SELECT COUNT(*) AS n FROM transactions WHERE ${where}`, params);
		return c.json({ success: true, transactions: rows.map(toTransaction), total: t.n, page, pages: Math.ceil(t.n / limit) });
	} catch (err) {
		console.error("transactions error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

wallet.get("/balance", protect, async (c) => {
	try {
		const user = await first(c.env.DB, `SELECT * FROM users WHERE id = ?`, [c.get("user").id]);
		const p = toPublicUser(user);
		return c.json({ success: true, balance: p.balance, preferredCurrency: p.preferredCurrency });
	} catch (err) {
		console.error("balance error:", err.message);
		return c.json({ success: false, message: "Internal server error" }, 500);
	}
});

export default wallet;
