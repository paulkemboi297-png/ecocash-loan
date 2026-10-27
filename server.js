const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set.');
if (!ADMIN_USER || !ADMIN_PASSWORD) console.warn('Set ADMIN_USER and ADMIN_PASSWORD.');
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SERVICE_SID) {
  console.warn('SMS OTP is not live until Twilio Verify credentials are configured.');
}
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) {
  console.warn('Telegram alerts/actions are not live until Telegram bot secrets are configured.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const schema = `
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY,
  loan_type TEXT NOT NULL,
  loan_amount NUMERIC NOT NULL,
  loan_term TEXT NOT NULL,
  purpose TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  employment_status TEXT NOT NULL,
  annual_income NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  otp_status TEXT NOT NULL DEFAULT 'pending',
  pin_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  otp_verified_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ
);
`;
pool.query(schema).then(async () => {
  // Upgrade databases created by the earlier package without losing applications.
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
}).catch(e => console.error('Database schema setup failed:', e.message));

function normalizePhone(value) {
  const x = String(value || '').replace(/[\s()-]/g, '');
  if (/^07\d{8}$/.test(x)) return '+263' + x.slice(1);
  if (/^7\d{8}$/.test(x)) return '+263' + x;
  if (/^\+2637\d{8}$/.test(x)) return x;
  if (/^2637\d{8}$/.test(x)) return '+' + x;
  return null;
}
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    return res.status(401).set('WWW-Authenticate', 'Basic realm="Loan Admin"').json({ error: 'Admin authentication required.' });
  }
  let raw = '';
  try { raw = Buffer.from(h.slice(6), 'base64').toString(); } catch {}
  const i = raw.indexOf(':');
  const user = raw.slice(0, i), pass = raw.slice(i + 1);
  if (user !== ADMIN_USER || pass !== ADMIN_PASSWORD) {
    return res.status(401).set('WWW-Authenticate', 'Basic realm="Loan Admin"').json({ error: 'Invalid admin credentials.' });
  }
  next();
}

async function telegramApi(method, body) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}
async function notifyTelegram(text, keyboard) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    await telegramApi('sendMessage', {
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
    });
  } catch (e) { console.error('Telegram notification failed:', e.message); }
}
async function sendOtp(phone) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service } = process.env;
  if (!sid || !token || !service) throw new Error('SMS verification is not configured yet. Please contact support.');
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/Verifications`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: phone, Channel: 'sms' });
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Twilio Verify send failed:', data.message || response.status);
    throw new Error('Could not send SMS verification code. Check the phone number or try again later.');
  }
  return data.status;
}
async function checkOtp(phone, code) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service } = process.env;
  if (!sid || !token || !service) throw new Error('SMS verification is not configured yet.');
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/VerificationCheck`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: phone, Code: code });
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Twilio Verify check failed:', data.message || response.status);
    throw new Error('The code could not be verified. Request a new code if it has expired.');
  }
  return data.status === 'approved';
}

function safeText(v) {
  return String(v ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}
async function setApplicationStatus(id, status, source='admin') {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid status');
  const result = await pool.query(
    'UPDATE applications SET status=$1, reviewed_at=NOW() WHERE id=$2 RETURNING id, status, phone, first_name, last_name',
    [status, id]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  await notifyTelegram(
    `Application ${status.toUpperCase()}\nID: ${row.id}\nApplicant: ${row.first_name} ${row.last_name}\nPhone: ${row.phone}\nUpdated by: ${source}`
  );
  return row;
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});

app.post('/api/applications', async (req, res) => {
  try {
    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    const amount = Number(b.loanAmount), income = Number(b.annualIncome);
    const required = ['loanType','loanTerm','purpose','firstName','lastName','email','employmentStatus'];
    if (required.some(k => !String(b[k] || '').trim()) || !phone || !Number.isFinite(amount) || !Number.isFinite(income)) {
      return res.status(400).json({ error: 'Please complete all application fields correctly.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (amount <= 0 || amount > 500000 || income <= 0) return res.status(400).json({ error: 'Enter valid loan and income amounts.' });
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO applications
      (id,loan_type,loan_amount,loan_term,purpose,first_name,last_name,email,phone,employment_status,annual_income,status,otp_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','pending')`,
      [id, String(b.loanType).slice(0,80), amount, String(b.loanTerm).slice(0,40), String(b.purpose).slice(0,1000),
       String(b.firstName).slice(0,100), String(b.lastName).slice(0,100), String(b.email).slice(0,200),
       phone, String(b.employmentStatus).slice(0,80), income]
    );
    try {
      await sendOtp(phone);
      await pool.query('UPDATE applications SET otp_status=$1 WHERE id=$2', ['sent', id]);
    } catch (otpError) {
      await notifyTelegram(
        `New loan application received\nID: ${id}\nApplicant: ${b.firstName} ${b.lastName}\nPhone: ${phone}\nLoan: USD ${amount} (${b.loanTerm})\nOTP status: NOT SENT\nReason: SMS provider setup/delivery needs attention.`,
        [[{ text: 'Open admin dashboard', url: `${process.env.PUBLIC_BASE_URL || ''}/admin` }]]
      );
      return res.status(503).json({ error: otpError.message, applicationId: id });
    }
    await notifyTelegram(
      `New loan application — awaiting review\nID: ${id}\nApplicant: ${b.firstName} ${b.lastName}\nPhone: ${phone}\nLoan type: ${b.loanType}\nAmount: USD ${amount}\nTerm: ${b.loanTerm}\nPurpose: ${b.purpose}\nEmployment: ${b.employmentStatus}\nAnnual income: USD ${income}\nOTP status: SMS code sent; verification pending.\n\nThe SMS code/PIN is never included in Telegram.`,
      [[
        { text: 'Approve', callback_data: `approve:${id}` },
        { text: 'Reject', callback_data: `reject:${id}` }
      ]]
    );
    res.json({ id, status: 'pending', otpStatus: 'sent' });
  } catch (e) {
    console.error('Application submission failed:', e);
    res.status(500).json({ error: 'Could not save application. Please try again.' });
  }
});

app.post('/api/applications/:id/verify-otp', async (req, res) => {
  try {
    const id = String(req.params.id);
    const code = String(req.body?.code || '').trim();
    if (!/^\d{4,10}$/.test(code)) return res.status(400).json({ error: 'Enter the SMS verification code.' });
    const found = await pool.query('SELECT id, phone, status, otp_status FROM applications WHERE id=$1', [id]);
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: 'Application not found.' });
    if (row.otp_status === 'verified') return res.json({ verified: true, status: row.status });
    const verified = await checkOtp(row.phone, code);
    if (!verified) {
      await notifyTelegram(`OTP verification attempt failed\nApplication ID: ${row.id}\nPhone: ${row.phone}\nStatus: OTP not verified.`);
      return res.status(400).json({ error: 'That code is incorrect or expired. Please try again.' });
    }
    await pool.query('UPDATE applications SET otp_status=$1, otp_verified_at=NOW() WHERE id=$2', ['verified', id]);
    await notifyTelegram(
      `OTP VERIFIED\nApplication ID: ${row.id}\nPhone: ${row.phone}\nThe SMS code was verified by the provider. The actual code is not stored or shared.`
    );
    res.json({ verified: true, status: row.status });
  } catch (e) {
    console.error('OTP verification failed:', e.message);
    res.status(503).json({ error: e.message || 'Verification is temporarily unavailable.' });
  }
});

app.post('/api/applications/:id/resend-otp', async (req, res) => {
  try {
    const found = await pool.query('SELECT id, phone, status, otp_status FROM applications WHERE id=$1', [req.params.id]);
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: 'Application not found.' });
    if (row.otp_status === 'verified') return res.json({ sent: false, verified: true });
    await sendOtp(row.phone);
    await pool.query('UPDATE applications SET otp_status=$1 WHERE id=$2', ['sent', row.id]);
    await notifyTelegram(`SMS OTP resent\nApplication ID: ${row.id}\nPhone: ${row.phone}\nStatus: awaiting customer verification.`);
    res.json({ sent: true });
  } catch (e) {
    res.status(503).json({ error: e.message || 'Could not resend SMS code.' });
  }
});

app.get('/api/applications/:id/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,status,otp_status FROM applications WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Application not found.' });
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Status unavailable.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const pin = String(req.body?.pin || '');
    if (!phone || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'Enter a valid Zimbabwe phone number and 4-digit PIN.' });
    const r = await pool.query('SELECT * FROM applications WHERE phone=$1 ORDER BY created_at DESC LIMIT 1', [phone]);
    const row = r.rows[0];
    if (!row) return res.status(401).json({ error: 'No application account found for this number.' });
    if (row.status !== 'approved') return res.status(403).json({ error: 'Your application has not been approved yet.' });
    if (row.otp_status !== 'verified') return res.status(403).json({ error: 'Verify your phone number before login.' });
    if (!row.pin_hash) return res.status(401).json({ error: 'PIN activation is not configured for this account yet. Do not send your PIN to an administrator.' });
    if (row.pin_hash !== hashPin(pin)) return res.status(401).json({ error: 'Incorrect PIN.' });
    res.json({ message: 'Login successful.' });
  } catch (e) {
    console.error('Login failed:', e.message);
    res.status(500).json({ error: 'Login unavailable.' });
  }
});

app.get('/api/admin/applications', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,loan_type,loan_amount,loan_term,purpose,first_name,last_name,email,phone,employment_status,annual_income,status,otp_status,created_at,otp_verified_at,reviewed_at FROM applications ORDER BY created_at DESC');
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Could not load applications.' }); }
});
app.patch('/api/admin/applications/:id', adminAuth, async (req, res) => {
  try {
    const s = req.body?.status;
    if (!['approved', 'rejected'].includes(s)) return res.status(400).json({ error: 'Status must be approved or rejected.' });
    const row = await setApplicationStatus(req.params.id, s, 'web admin');
    if (!row) return res.status(404).json({ error: 'Application not found.' });
    res.json({ id: row.id, status: row.status });
  } catch { res.status(500).json({ error: 'Could not update application.' }); }
});

app.get('/admin', adminAuth, (req, res) => res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>EcoCash Loan Admin</title>
<style>
body{font-family:Arial,sans-serif;margin:0;padding:18px;background:#f2f6fb;color:#152238}
h1{color:#0753a6}.sub{color:#5d6b7e}.card{background:#fff;padding:16px;margin:12px 0;border-radius:12px;box-shadow:0 2px 10px #dce3eb;overflow-wrap:anywhere}
button{padding:10px 14px;border:0;border-radius:7px;margin:5px 5px 0 0;cursor:pointer;font-weight:700}.approve{background:#13834b;color:#fff}.reject{background:#c83737;color:#fff}
.pill{display:inline-block;border-radius:99px;padding:4px 9px;background:#edf2f7;margin:4px 4px 4px 0;font-size:12px}
</style></head><body><h1>EcoCash Loan Applications</h1><p class="sub">Review applications and phone-verification status. SMS codes and account PINs are never displayed here.</p>
<div id="list">Loading applications…</div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){try{const r=await fetch('/api/admin/applications');if(!r.ok)throw Error('Unable to load. Refresh and sign in again.');const a=await r.json();document.getElementById('list').innerHTML=a.map(x=>'<div class="card"><h3>'+esc(x.first_name)+' '+esc(x.last_name)+'</h3><span class="pill">Application: '+esc(x.status)+'</span><span class="pill">Phone OTP: '+esc(x.otp_status)+'</span><p><b>ID:</b> '+esc(x.id)+'</p><p><b>Phone:</b> '+esc(x.phone)+'<br><b>Email:</b> '+esc(x.email)+'</p><p><b>Loan:</b> '+esc(x.loan_type)+' — USD '+esc(x.loan_amount)+'<br><b>Term:</b> '+esc(x.loan_term)+'<br><b>Purpose:</b> '+esc(x.purpose)+'</p><p><b>Employment:</b> '+esc(x.employment_status)+'<br><b>Annual income:</b> USD '+esc(x.annual_income)+'</p><p><b>Submitted:</b> '+esc(new Date(x.created_at).toLocaleString())+'</p><button class="approve" onclick="setStatus(\\''+x.id+'\\',\\'approved\\')">Approve</button><button class="reject" onclick="setStatus(\\''+x.id+'\\',\\'rejected\\')">Reject</button></div>').join('')||'No applications yet.'}catch(e){document.getElementById('list').textContent=e.message}}
async function setStatus(id,status){if(!confirm('Set this application to '+status+'?'))return;const r=await fetch('/api/admin/applications/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});if(!r.ok){alert('Could not update status.');return}load()}
load();setInterval(load,20000);
</script></body></html>`));

/* Telegram bot polling: only the configured admin chat can run commands/buttons.
   It never receives SMS codes or customer PINs. */
let telegramOffset = 0;
let telegramPolling = false;
async function processTelegramUpdate(update) {
  const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '');
  const fromId = String(update.message?.from?.id ?? update.callback_query?.from?.id ?? '');
  if (!process.env.TELEGRAM_ADMIN_CHAT_ID || chatId !== String(process.env.TELEGRAM_ADMIN_CHAT_ID) || (process.env.TELEGRAM_ADMIN_USER_ID && fromId !== String(process.env.TELEGRAM_ADMIN_USER_ID))) {
    if (update.callback_query?.id) {
      try { await telegramApi('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Not authorized.' }); } catch {}
    }
    return;
  }
  if (update.callback_query) {
    const q = update.callback_query;
    const match = /^(approve|reject):([0-9a-f-]{36})$/i.exec(q.data || '');
    if (!match) return;
    try {
      const row = await setApplicationStatus(match[2], match[1] === 'approve' ? 'approved' : 'rejected', 'Telegram admin');
      await telegramApi('answerCallbackQuery', { callback_query_id: q.id, text: row ? `Application ${row.status}` : 'Application not found' });
      if (row) {
        await telegramApi('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(()=>{});
      }
    } catch (e) {
      try { await telegramApi('answerCallbackQuery', { callback_query_id: q.id, text: 'Could not update application.' }); } catch {}
    }
    return;
  }
  const message = update.message?.text?.trim() || '';
  if (message === '/start' || message === '/help') {
    await notifyTelegram('Admin bot is connected. Commands:\n/pending — list pending application IDs\n/status APPLICATION_ID — show status\nOnly your configured admin chat is authorized.');
  } else if (message === '/pending') {
    const r = await pool.query("SELECT id,first_name,last_name,phone,loan_amount,loan_term,otp_status FROM applications WHERE status='pending' ORDER BY created_at DESC LIMIT 20");
    if (!r.rows.length) return notifyTelegram('No pending applications.');
    for (const x of r.rows) await notifyTelegram(`Pending application\nID: ${x.id}\nApplicant: ${x.first_name} ${x.last_name}\nPhone: ${x.phone}\nLoan: USD ${x.loan_amount} (${x.loan_term})\nOTP status: ${x.otp_status}`, [[{text:'Approve',callback_data:`approve:${x.id}`},{text:'Reject',callback_data:`reject:${x.id}`} ]]);
  } else if (message.startsWith('/status ')) {
    const id = message.split(/\s+/)[1];
    const r = await pool.query('SELECT id,status,otp_status,phone,first_name,last_name FROM applications WHERE id=$1',[id]);
    const x = r.rows[0];
    await notifyTelegram(x ? `Application status\nID: ${x.id}\nApplicant: ${x.first_name} ${x.last_name}\nPhone: ${x.phone}\nApplication: ${x.status}\nOTP verification: ${x.otp_status}` : 'Application not found.');
  } else if (message === '/whoami') {
    await notifyTelegram(`Authorized chat ID: ${chatId}\nYour Telegram user ID: ${fromId}`);
  }
}
async function telegramPollLoop() {
  if (telegramPolling || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  telegramPolling = true;
  while (true) {
    try {
      const result = await telegramApi('getUpdates', { offset: telegramOffset, timeout: 20, allowed_updates: ['message','callback_query'] });
      for (const u of result || []) {
        telegramOffset = Math.max(telegramOffset, u.update_id + 1);
        try { await processTelegramUpdate(u); } catch (e) { console.error('Telegram update failed:', e.message); }
      }
    } catch (e) {
      console.error('Telegram polling issue:', e.message);
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
}
app.listen(PORT, () => {
  console.log('EcoCash application service listening on ' + PORT);
  telegramPollLoop();
});
