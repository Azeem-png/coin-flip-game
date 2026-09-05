// Email via fetch-based APIs only (Workers have no SMTP ports).
// Tier 1: Gmail REST API (OAuth2) → Tier 2: Brevo HTTPS API.

async function fetchTimeout(url, options = {}, ms = 10000) {
	const res = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
	return res;
}

async function sendViaGmailAPI(env, to, subject, html) {
	const tokenRes = await fetchTimeout("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: "refresh_token"
		}).toString()
	});
	if (!tokenRes.ok) throw new Error(`Gmail token error: ${tokenRes.status}`);
	const { access_token } = await tokenRes.json();
	const rawEmail = [
		`From: "CoinFlip Game" <${env.EMAIL_USER}>`,
		`To: ${to}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		"",
		html
	].join("\r\n");
	const raw = btoa(String.fromCharCode(...new TextEncoder().encode(rawEmail)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const sendRes = await fetchTimeout("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
		method: "POST",
		headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ raw })
	});
	if (sendRes.status !== 200 && sendRes.status !== 201) throw new Error(`Gmail API error: ${sendRes.status}`);
}

async function sendViaBrevo(env, to, subject, html) {
	const res = await fetchTimeout(
		"https://api.brevo.com/v3/smtp/email",
		{
			method: "POST",
			headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" },
			body: JSON.stringify({
				sender: { email: env.EMAIL_USER || "noreply.coinflip.support@gmail.com", name: "CoinFlip Game" },
				to: [{ email: to }],
				subject,
				htmlContent: html
			})
		},
		5000
	);
	if (!res.ok) throw new Error(`Brevo error: ${res.status}`);
}

export async function sendEmail(env, to, subject, html) {
	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
		try {
			await sendViaGmailAPI(env, to, subject, html);
			return true;
		} catch (err) {
			console.warn("GMAIL_API_ERROR:", err.message);
		}
	}
	if (env.BREVO_API_KEY) {
		try {
			await sendViaBrevo(env, to, subject, html);
			return true;
		} catch (err) {
			console.warn("BREVO_ERROR:", err.message);
		}
	}
	console.warn("EMAIL_NOT_SENT: no email provider configured");
	return false;
}

export function emailTemplate(env, content) {
	const base = env.FRONTEND_URL || "https://coin-flip-game-4my6.onrender.com";
	const logoUrl = `${base}/icons/icon-192.png`;
	return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:30px 10px;">
      <table role="presentation" width="600" style="max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#1a73e8,#0d47a1);padding:30px;text-align:center;">
          <img src="${logoUrl}" alt="CoinFlip" width="64" height="64" style="border-radius:16px;vertical-align:middle;">
          <h1 style="color:#fff;margin:10px 0 0;font-size:22px;">CoinFlip Game</h1>
        </td></tr>
        <tr><td style="padding:30px;color:#333;font-size:15px;line-height:1.6;">
          ${content}
        </td></tr>
        <tr><td style="padding:20px 30px;border-top:1px solid #eee;text-align:center;color:#999;font-size:12px;">
          &copy; 2026 CoinFlip Game &mdash; This is an automated message.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendOTPEmail(env, email, otp, name) {
	const content = `<h2 style="margin-top:0;">Hello ${name}!</h2><p>Use the OTP below to verify your email address. Valid for <strong>10 minutes</strong>.</p><div style="background:#f0f4ff;border-radius:8px;padding:16px;text-align:center;font-size:32px;letter-spacing:6px;font-family:monospace;font-weight:bold;color:#1a73e8;margin:20px 0;">${otp}</div><p style="color:#666;font-size:13px;">If you didn't create an account, ignore this email.</p>`;
	await sendEmail(env, email, "Your OTP - CoinFlip Game", emailTemplate(env, content));
}

export async function sendResetEmail(env, email, resetUrl) {
	const content = `<h2 style="margin-top:0;">Password Reset</h2><p>Click the button below to reset your password. This link is valid for <strong>15 minutes</strong>.</p><div style="text-align:center;margin:24px 0;"><a href="${resetUrl}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;">Reset Password</a></div><p style="color:#666;font-size:13px;">If you didn't request a password reset, ignore this email. Your account is secure.</p>`;
	await sendEmail(env, email, "Password Reset - CoinFlip Game", emailTemplate(env, content));
}
