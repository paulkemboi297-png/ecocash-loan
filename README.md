# EcoCash loan application — deployment package v2

This package preserves the five customer screens and the post-submission confirmation screen. It adds real server-side storage, SMS OTP verification through Twilio Verify, Telegram notifications, Telegram approve/reject buttons, and an admin dashboard.

## What this version does

1. A customer completes the application.
2. The server stores the application in PostgreSQL.
3. Twilio Verify sends a real SMS code to the customer's Zimbabwe mobile number.
4. The customer enters the code on the website. The server asks Twilio Verify to validate it.
5. Telegram receives the application details and OTP status — never the SMS code or an account PIN.
6. You can approve/reject using the Telegram inline buttons or the `/admin` dashboard.
7. Login remains locked until both phone verification and admin approval are complete.

**Important:** This is a deployment package, not a claim that your currently hosted site has already been updated. You must deploy these files and set up the external provider credentials below.

## Deploy on Render

Use a **Web Service**, not a Static Site.

- Build command: `npm install`
- Start command: `npm start`
- Add a PostgreSQL database, or deploy using the included `render.yaml`.
- Set all environment variables listed below.
- Set `PUBLIC_BASE_URL` to your final Render URL, e.g. `https://your-service.onrender.com`.
- After deployment, open `/api/health` and expect `{"ok":true,"database":"connected"}`.

### Required environment variables

**Admin dashboard**
- `ADMIN_USER`: choose a unique admin username.
- `ADMIN_PASSWORD`: use a long, unique password.

**Telegram**
- `TELEGRAM_BOT_TOKEN`: token from Telegram's official `@BotFather`.
- `TELEGRAM_ADMIN_CHAT_ID`: numeric chat ID for the private admin chat where alerts should be sent.
- `TELEGRAM_ADMIN_USER_ID`: optional but recommended; your Telegram numeric user ID. If set, actions are accepted only from that user ID as well as the configured chat.

To find the chat ID safely, start the bot and use a trusted Telegram bot/chat-ID method. Do not post your bot token publicly or send it to anyone. A bot must be started by you in Telegram before it can message you.

The bot supports:
- `/start` or `/help`
- `/pending`
- `/status APPLICATION_ID`
- Inline **Approve** and **Reject** buttons

The bot only accepts commands/actions from the configured admin chat and, when configured, admin user ID. Never share the bot token.

**Real SMS OTP**
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`

Create a Twilio Verify service in your Twilio account and make sure your account/service can send SMS to Zimbabwe (+263). SMS delivery and cost depend on your provider account, country permissions, and recipient carrier. Until these three values are configured correctly, OTP is not live.

## Security boundaries

- OTP codes are not saved in the app database, logs, Telegram, or admin dashboard.
- Account PINs are never sent to Telegram or shown to admins.
- Telegram reports the result `OTP verified` or `OTP pending`, which is enough to review the application.
- Use HTTPS and strong secret values. Do not commit `.env` files or provider tokens to GitHub.
- Before using this for real lending or handling money, obtain legal/compliance review and implement proper account onboarding, sessions, rate limiting, audit logging, and an approved lending/payment provider.

## Login limitation

The provided five-screen design has a login PIN entry but no secure PIN creation/reset screen. This package intentionally does not store or guess a customer's PIN. Until a proper secure PIN enrollment flow is added, an approved customer may still be unable to log in. Do not ask customers to send their PIN to an administrator. A production version should use a trusted authentication provider or add a secure customer-controlled PIN setup flow.

## Existing Render Static Site

If your current Render deployment is a Static Site, this backend will not run there. Create/switch to a Render **Web Service**, connect the repository, and deploy the backend project. The existing live site does not change until the new build deploys successfully.
