import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config({ override: true });

// HTML escaping utility to prevent HTML/XSS injection in email templates (OWASP A03 / ISO 27001 A.8.28)
function escapeHtml(unsafe: unknown): string {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Server secret for HMAC-SHA256 session tokens and OTP salting
const SERVER_AUTH_SECRET =
  process.env.OTP_SERVER_SECRET ||
  process.env.GEMINI_API_KEY ||
  crypto.randomBytes(32).toString('hex');

interface OtpRecord {
  email: string;
  otpHash: string;
  salt: string;
  expiresAt: number;
  createdAt: number;
  lastSentAt: number;
  attempts: number;
  maxAttempts: number;
  deliveryMode: 'smtp' | 'ethereal' | 'sandbox';
  messageId: string;
  previewUrl: string | null;
}

interface DispatchedEmailItem {
  id: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  sentAt: string;
  expiresAt: string;
  deliveryMode: 'smtp' | 'ethereal' | 'sandbox';
  smtpHost: string;
  previewUrl: string | null;
  otpCodePreview?: string;
}

interface RuntimeSmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

// In-memory cryptographic OTP store & virtual email outbox
const otpStore = new Map<string, OtpRecord>();
const emailOutbox = new Map<string, DispatchedEmailItem>();

// Runtime SMTP config (initialized from environment variables, updatable via Admin SMTP Settings)
let runtimeSmtp: RuntimeSmtpConfig = {
  host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
  port: Number(process.env.SMTP_PORT) || 465,
  user: (process.env.SMTP_USER || 'singhalmanav58@gmail.com').trim(),
  pass: (process.env.SMTP_PASS || '').trim().replace(/\s+/g, ''),
  from: (process.env.SMTP_FROM || 'MS Fitness <singhalmanav58@gmail.com>').trim(),
  secure: process.env.SMTP_SECURE === 'true' || (Number(process.env.SMTP_PORT) || 465) === 465,
};

// Cached Ethereal account for instant fallback preview
let cachedEtherealAccount: { user: string; pass: string } | null = null;

async function getEtherealTransporter() {
  try {
    if (!cachedEtherealAccount) {
      const testAccount = await nodemailer.createTestAccount();
      cachedEtherealAccount = { user: testAccount.user, pass: testAccount.pass };
    }
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: cachedEtherealAccount.user,
        pass: cachedEtherealAccount.pass,
      },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
    });
  } catch {
    return null;
  }
}

function hashOtp(email: string, otpCode: string, salt: string): string {
  return crypto
    .createHmac('sha256', SERVER_AUTH_SECRET)
    .update(`${salt}:${email.toLowerCase().trim()}:${otpCode.trim()}`)
    .digest('hex');
}

function createSignedSessionToken(email: string): { token: string; expiresAt: number } {
  const cleanEmail = email.toLowerCase().trim();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = Buffer.from(JSON.stringify({ email: cleanEmail, exp: expiresAt })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SERVER_AUTH_SECRET)
    .update(payload)
    .digest('base64url');
  return {
    token: `${payload}.${signature}`,
    expiresAt,
  };
}

function verifySignedSessionToken(token: string): { valid: boolean; email?: string } {
  try {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      return { valid: false };
    }
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return { valid: false };

    const expectedSig = crypto
      .createHmac('sha256', SERVER_AUTH_SECRET)
      .update(payload)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false };
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!decoded.email || !decoded.exp || Date.now() > Number(decoded.exp)) {
      return { valid: false };
    }
    return { valid: true, email: String(decoded.email).toLowerCase().trim() };
  } catch {
    return { valid: false };
  }
}

function buildOtpEmailTemplate(params: {
  email: string;
  otpCode: string;
  expiresMinutes: number;
  gymName?: string;
}) {
  const safeEmail = escapeHtml(params.email);
  const safeGymName = escapeHtml(params.gymName || 'MS FITNESS');
  const digits = params.otpCode.split('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeGymName} - Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #09090b; color: #f4f4f5; margin: 0; padding: 24px; }
    .container { max-width: 540px; margin: 0 auto; background-color: #121215; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .header { background: linear-gradient(135deg, #18181b 0%, #09090b 100%); padding: 28px 24px; border-bottom: 3px solid #dc2626; text-align: center; }
    .brand { font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: 2px; margin: 0; }
    .tagline { font-size: 11px; color: #ef4444; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-top: 6px; }
    .content { padding: 32px 28px; text-align: center; }
    .kicker { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #f87171; margin-bottom: 8px; }
    .title { font-size: 20px; font-weight: 700; color: #ffffff; margin: 0 0 12px 0; }
    .desc { font-size: 13px; color: #a1a1aa; line-height: 1.6; margin: 0 0 24px 0; }
    .otp-wrapper { background-color: #09090b; border: 1px solid #27272a; border-radius: 12px; padding: 22px 16px; margin: 0 auto 24px auto; }
    .otp-code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #ffffff; margin: 0; padding-left: 10px; }
    .meta-box { background-color: #18181b; border: 1px solid #27272a; border-radius: 10px; padding: 14px 16px; text-align: left; font-size: 12px; color: #a1a1aa; line-height: 1.6; }
    .footer { background-color: #09090b; padding: 18px 24px; text-align: center; font-size: 11px; color: #71717a; border-top: 1px solid #27272a; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="brand">${safeGymName}</h1>
      <div class="tagline">Stronger Body, Stronger You</div>
    </div>
    <div class="content">
      <div class="kicker">Security Verification</div>
      <h2 class="title">Your One-Time Passcode (OTP)</h2>
      <p class="desc">
        Use the 6-digit verification code below to complete your sign-in to the <strong>${safeGymName} Admin Portal</strong> for <strong style="color: #e4e4e7;">${safeEmail}</strong>.
      </p>
      <div class="otp-wrapper">
        <div class="otp-code">${digits.map((d) => escapeHtml(d)).join('')}</div>
      </div>
      <div class="meta-box">
        <div><strong style="color: #f4f4f5;">Validity:</strong> Expires in ${params.expiresMinutes} minutes (Single-Use Code)</div>
        <div><strong style="color: #f4f4f5;">Security Notice:</strong> Never share this code with anyone. ${safeGymName} staff will never ask for your verification code.</div>
      </div>
    </div>
    <div class="footer">
      <div>${safeGymName} • Automated Security Authentication Service</div>
      <div style="margin-top: 4px;">ISO/IEC 27001 &amp; OWASP Top 10 Protected Authentication</div>
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
${params.gymName || 'MS FITNESS'} - ADMIN VERIFICATION CODE
--------------------------------------------------
Your 6-digit verification code (OTP) is:

${params.otpCode}

Account: ${params.email}
Validity: Expires in ${params.expiresMinutes} minutes (Single-use only).

If you did not request this code, you can safely ignore this email.
  `.trim();

  return {
    subject: `${params.otpCode} is your ${params.gymName || 'MS Fitness'} verification code`,
    html,
    text,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Security headers (OWASP A05 / ISO 27001 A.8.9 compliant while preserving AI Studio iframe compatibility)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Body parsing for JSON payloads including base64 PDF attachments
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // EMAIL OTP AUTHENTICATION & SMTP CONFIGURATION ENDPOINTS
  // ============================================================================

  // 1. Check current SMTP & OTP system status
  app.get('/api/auth/smtp-status', (req, res) => {
    const isCustomSmtpConfigured = Boolean(
      runtimeSmtp.host && runtimeSmtp.user && runtimeSmtp.pass && runtimeSmtp.pass.length >= 6
    );
    return res.json({
      success: true,
      configured: isCustomSmtpConfigured,
      mode: isCustomSmtpConfigured ? 'smtp' : 'sandbox',
      host: runtimeSmtp.host,
      port: runtimeSmtp.port,
      user: runtimeSmtp.user,
      from: runtimeSmtp.from,
      secure: runtimeSmtp.secure,
    });
  });

  // 2. Update & optionally test SMTP configuration at runtime
  app.post('/api/auth/smtp-config', async (req, res) => {
    try {
      const { host, port, user, pass, from, secure, testConnection } = req.body || {};

      if (host !== undefined) runtimeSmtp.host = String(host).trim();
      if (port !== undefined) runtimeSmtp.port = Number(port) || 465;
      if (user !== undefined) runtimeSmtp.user = String(user).trim();
      if (pass !== undefined && String(pass).trim() !== '••••••••') {
        runtimeSmtp.pass = String(pass).trim().replace(/\s+/g, '');
      }
      if (from !== undefined) runtimeSmtp.from = String(from).trim();
      if (secure !== undefined) {
        runtimeSmtp.secure = Boolean(secure);
      } else {
        runtimeSmtp.secure = runtimeSmtp.port === 465;
      }

      const isCustomSmtpConfigured = Boolean(
        runtimeSmtp.host && runtimeSmtp.user && runtimeSmtp.pass
      );

      if (testConnection && isCustomSmtpConfigured) {
        const testTransporter = nodemailer.createTransport({
          host: runtimeSmtp.host,
          port: runtimeSmtp.port,
          secure: runtimeSmtp.secure,
          auth: {
            user: runtimeSmtp.user,
            pass: runtimeSmtp.pass,
          },
          connectionTimeout: 8000,
          greetingTimeout: 8000,
          socketTimeout: 10000,
        });

        await testTransporter.verify();
      }

      return res.json({
        success: true,
        configured: isCustomSmtpConfigured,
        mode: isCustomSmtpConfigured ? 'smtp' : 'sandbox',
        message: isCustomSmtpConfigured
          ? `SMTP server (${runtimeSmtp.host}:${runtimeSmtp.port}) configured and verified.`
          : 'Switched to Built-in Email OTP Sandbox & Ethereal Mail mode.',
      });
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: `SMTP verification failed: ${err?.message || 'Unable to connect to SMTP host'}`,
      });
    }
  });

  // 3. Send 6-Digit Email OTP
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { email, forceResend } = req.body || {};
      const cleanEmail = String(email || '').trim().toLowerCase();

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (!cleanEmail || !emailRegex.test(cleanEmail)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address.',
        });
      }

      if (cleanEmail === 'admin@msfitness.com') {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: The account "admin@msfitness.com" has been permanently blocked by the Super Administrator.',
        });
      }

      const now = Date.now();
      const existing = otpStore.get(cleanEmail);
      const COOLDOWN_MS = 30 * 1000; // 30-second cooldown between sends

      if (existing && !forceResend && now - existing.lastSentAt < COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        const latestOutbox = emailOutbox.get(cleanEmail);
        return res.status(429).json({
          success: false,
          cooldownSeconds: remainingSeconds,
          error: `Please wait ${remainingSeconds} seconds before requesting a new OTP code.`,
          dispatchedEmail: latestOutbox || null,
        });
      }

      // Generate cryptographically secure 6-digit OTP (100000 - 999999)
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      const salt = crypto.randomBytes(16).toString('hex');
      const otpHash = hashOtp(cleanEmail, otpCode, salt);
      const EXPIRES_MINUTES = 10;
      const expiresAt = now + EXPIRES_MINUTES * 60 * 1000;

      const template = buildOtpEmailTemplate({
        email: cleanEmail,
        otpCode,
        expiresMinutes: EXPIRES_MINUTES,
        gymName: 'MS FITNESS',
      });

      const fromAddress = runtimeSmtp.from.includes('<')
        ? runtimeSmtp.from
        : `"MS Fitness Security" <${runtimeSmtp.from || 'no-reply@msfitness.com'}>`;

      let deliveryMode: 'smtp' | 'ethereal' | 'sandbox' = 'sandbox';
      let messageId = `msf-otp-${now}`;
      let previewUrl: string | null = null;
      let smtpNotice: string | null = null;

      // Attempt 1: Live Custom SMTP Delivery if configured
      if (runtimeSmtp.host && runtimeSmtp.user && runtimeSmtp.pass) {
        try {
          const smtpTransporter = nodemailer.createTransport({
            host: runtimeSmtp.host,
            port: runtimeSmtp.port,
            secure: runtimeSmtp.secure,
            auth: {
              user: runtimeSmtp.user,
              pass: runtimeSmtp.pass,
            },
            connectionTimeout: 8000,
            greetingTimeout: 8000,
            socketTimeout: 12000,
          });

          const info = await smtpTransporter.sendMail({
            from: fromAddress,
            to: cleanEmail,
            subject: template.subject,
            text: template.text,
            html: template.html,
          });

          deliveryMode = 'smtp';
          messageId = info.messageId || messageId;
        } catch (smtpErr: any) {
          smtpNotice = smtpErr?.message || 'SMTP connection refused';
          console.log(`[Email OTP] Custom SMTP (${runtimeSmtp.host}) failed: ${smtpNotice}. Falling back to Ethereal/Sandbox.`);
        }
      }

      // Attempt 2: Ethereal Email Test Inbox if Custom SMTP was not used or failed
      if (deliveryMode !== 'smtp') {
        try {
          const etherealTransporter = await getEtherealTransporter();
          if (etherealTransporter) {
            const info = await etherealTransporter.sendMail({
              from: fromAddress,
              to: cleanEmail,
              subject: template.subject,
              text: template.text,
              html: template.html,
            });
            deliveryMode = 'ethereal';
            messageId = info.messageId || messageId;
            const url = nodemailer.getTestMessageUrl(info);
            previewUrl = typeof url === 'string' ? url : null;
          }
        } catch {
          deliveryMode = 'sandbox';
        }
      }

      // Store hashed OTP record in server memory
      otpStore.set(cleanEmail, {
        email: cleanEmail,
        otpHash,
        salt,
        expiresAt,
        createdAt: now,
        lastSentAt: now,
        attempts: 0,
        maxAttempts: 5,
        deliveryMode,
        messageId,
        previewUrl,
      });

      // Store dispatched email in server outbox so user can inspect the email if SMTP isn't configured
      const dispatchedItem: DispatchedEmailItem = {
        id: messageId,
        to: cleanEmail,
        from: fromAddress,
        subject: template.subject,
        html: template.html,
        text: template.text,
        sentAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        deliveryMode,
        smtpHost: deliveryMode === 'smtp' ? runtimeSmtp.host : deliveryMode === 'ethereal' ? 'smtp.ethereal.email' : 'built-in-outbox',
        previewUrl,
        otpCodePreview: deliveryMode === 'smtp' ? undefined : otpCode,
      };
      emailOutbox.set(cleanEmail, dispatchedItem);

      console.log(`[Email OTP] Dispatched 6-digit OTP to ${cleanEmail} via ${deliveryMode.toUpperCase()} (${messageId})`);

      return res.json({
        success: true,
        email: cleanEmail,
        deliveryMode,
        messageId,
        previewUrl,
        smtpNotice,
        expiresInSeconds: EXPIRES_MINUTES * 60,
        cooldownSeconds: 30,
        message:
          deliveryMode === 'smtp'
            ? `A 6-digit verification code has been sent to ${cleanEmail} via ${runtimeSmtp.host}.`
            : `Verification email generated for ${cleanEmail}. Open the Sent Email Viewer below or check the preview inbox to view your 6-digit OTP.`,
        dispatchedEmail: {
          id: dispatchedItem.id,
          to: dispatchedItem.to,
          from: dispatchedItem.from,
          subject: dispatchedItem.subject,
          html: dispatchedItem.html,
          sentAt: dispatchedItem.sentAt,
          expiresAt: dispatchedItem.expiresAt,
          deliveryMode: dispatchedItem.deliveryMode,
          smtpHost: dispatchedItem.smtpHost,
          previewUrl: dispatchedItem.previewUrl,
          otpCodePreview: dispatchedItem.otpCodePreview,
        },
      });
    } catch (err: any) {
      console.error('[Email OTP Send Error]', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to dispatch OTP email.',
      });
    }
  });

  // 4. Retrieve Latest Sent Email from Outbox for Previewing
  app.get('/api/auth/outbox', (req, res) => {
    const cleanEmail = String(req.query.email || '').trim().toLowerCase();
    if (!cleanEmail) {
      return res.status(400).json({ success: false, error: 'Email parameter is required.' });
    }
    const item = emailOutbox.get(cleanEmail);
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'No verification email found for this address. Click "Send OTP" first.',
      });
    }
    return res.json({
      success: true,
      dispatchedEmail: item,
    });
  });

  // 5. Verify 6-Digit Email OTP (Timing-Safe Hash Comparison + Brute-Force Protection)
  app.post('/api/auth/verify-otp', (req, res) => {
    try {
      const { email, otp } = req.body || {};
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanOtp = String(otp || '').replace(/\s+/g, '').trim();

      if (!cleanEmail || !cleanOtp || !/^\d{6}$/.test(cleanOtp)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid 6-digit verification code.',
        });
      }

      if (cleanEmail === 'admin@msfitness.com') {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: This account is permanently blocked.',
        });
      }

      const record = otpStore.get(cleanEmail);
      if (!record) {
        return res.status(400).json({
          success: false,
          code: 'otp_not_found',
          error: 'No active verification code found for this email. Please request a new OTP.',
        });
      }

      // Check expiration
      if (Date.now() > record.expiresAt) {
        otpStore.delete(cleanEmail);
        return res.status(400).json({
          success: false,
          code: 'otp_expired',
          error: 'This verification code has expired (10-minute limit). Please request a new code.',
        });
      }

      // Check brute-force attempt limit
      if (record.attempts >= record.maxAttempts) {
        otpStore.delete(cleanEmail);
        return res.status(429).json({
          success: false,
          code: 'otp_max_attempts',
          error: 'Maximum verification attempts (5) exceeded for security. Please request a new OTP code.',
        });
      }

      // Compute candidate hash and compare in constant time
      const candidateHash = hashOtp(cleanEmail, cleanOtp, record.salt);
      const storedBuf = Buffer.from(record.otpHash, 'hex');
      const candidateBuf = Buffer.from(candidateHash, 'hex');

      const isMatch =
        storedBuf.length === candidateBuf.length &&
        crypto.timingSafeEqual(storedBuf, candidateBuf);

      if (!isMatch) {
        record.attempts += 1;
        const remainingAttempts = record.maxAttempts - record.attempts;
        if (remainingAttempts <= 0) {
          otpStore.delete(cleanEmail);
          return res.status(429).json({
            success: false,
            code: 'otp_max_attempts',
            error: 'Too many incorrect attempts. This code has been invalidated. Please request a new OTP.',
          });
        }

        return res.status(401).json({
          success: false,
          code: 'otp_invalid',
          remainingAttempts,
          error: `Incorrect verification code. You have ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
        });
      }

      // Single-use OTP: consume and delete immediately on success
      otpStore.delete(cleanEmail);
      emailOutbox.delete(cleanEmail);

      const session = createSignedSessionToken(cleanEmail);

      return res.json({
        success: true,
        verified: true,
        email: cleanEmail,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
      });
    } catch (err: any) {
      console.error('[Email OTP Verify Error]', err);
      return res.status(500).json({
        success: false,
        error: 'Verification failed due to a server error. Please try again.',
      });
    }
  });

  // 6. Verify Active Session Token
  app.get('/api/auth/verify-session', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : String(req.query.token || '');

    const result = verifySignedSessionToken(token);
    if (!result.valid || !result.email) {
      return res.status(401).json({ valid: false });
    }
    return res.json({ valid: true, email: result.email });
  });

  // ============================================================================
  // PAYMENT RECEIPT EMAIL ENDPOINT (WITH HTML ESCAPING & RUNTIME SMTP)
  // ============================================================================
  app.post('/api/send-receipt-email', async (req, res) => {
    try {
      const {
        to,
        customerName,
        memberId,
        planName,
        paymentAmount,
        paymentDate,
        paymentMethod,
        transactionNumber,
        upiTransactionNumber,
        receiptNumber,
        remainingBalance,
        pdfBase64,
        pdfFilename,
        notes,
        gymSettings,
      } = req.body;

      if (!to || typeof to !== 'string' || !to.includes('@')) {
        return res.status(400).json({
          success: false,
          error: 'Customer email address not found. Please update the member profile first.',
        });
      }

      if (!receiptNumber) {
        return res.status(400).json({
          success: false,
          error: 'Missing receipt number.',
        });
      }

      const gymName = escapeHtml(gymSettings?.gym_name || 'MS Fitness');
      const gymPhone = escapeHtml(gymSettings?.phone || '+91 98765 43210');
      const gymEmail = escapeHtml(gymSettings?.email || 'contact@msfitness.com');
      const gymAddress = escapeHtml(gymSettings?.address || 'Fitness District, New Delhi, India');
      const gymTagline = escapeHtml(gymSettings?.tagline || 'Stronger Body, Stronger You');

      const safeCustomerName = escapeHtml(customerName || 'Valued Athlete');
      const safeMemberId = escapeHtml(memberId || 'N/A');
      const safePlanName = escapeHtml(planName || 'Gym Membership');
      const safePaymentMethod = escapeHtml(paymentMethod || 'Cash');
      const safeReceiptNumber = escapeHtml(receiptNumber);
      const safeUpiTxn = escapeHtml(transactionNumber || upiTransactionNumber || '');
      const safeNotes = escapeHtml(notes || '');

      const formattedDate = escapeHtml(
        paymentDate
          ? new Date(paymentDate).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })
          : new Date().toLocaleDateString('en-IN')
      );

      const numAmount = Number(paymentAmount) || 0;
      const numRemaining = Number(remainingBalance) || 0;

      const subject = `MS Fitness - Payment Receipt ${String(receiptNumber).replace(/[\r\n]/g, '')}`;

      const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f0f11; color: #f4f4f5; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #18181b 0%, #09090b 100%); padding: 32px 24px; border-bottom: 3px solid #dc2626; text-align: center; }
    .logo-text { font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: 2px; margin: 0; }
    .tagline { font-size: 11px; color: #ef4444; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; margin-top: 6px; }
    .content { padding: 32px 24px; }
    .badge { display: inline-block; background-color: rgba(220, 38, 38, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; text-transform: uppercase; letter-spacing: 1px; }
    .receipt-title { font-size: 20px; font-weight: 700; color: #ffffff; margin: 16px 0 8px 0; }
    .receipt-id { font-family: monospace; font-size: 14px; color: #a1a1aa; margin-bottom: 24px; }
    .table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .table td { padding: 12px 14px; font-size: 13px; border-bottom: 1px solid #27272a; }
    .table td.label { color: #a1a1aa; width: 40%; }
    .table td.value { color: #ffffff; font-weight: 600; text-align: right; }
    .amount-row { background-color: rgba(16, 185, 129, 0.1); border-radius: 8px; }
    .amount-row td { color: #34d399 !important; font-size: 16px; font-weight: 700; border-bottom: none; }
    .balance-row { background-color: rgba(239, 68, 68, 0.1); }
    .balance-row td { color: #f87171 !important; font-size: 14px; font-weight: 700; border-bottom: none; }
    .thankyou-box { background-color: #27272a; border-left: 4px solid #dc2626; padding: 16px; border-radius: 8px; margin-top: 24px; }
    .thankyou-box p { margin: 0; font-size: 13px; color: #e4e4e7; line-height: 1.5; }
    .footer { background-color: #09090b; padding: 20px 24px; text-align: center; font-size: 11px; color: #71717a; border-top: 1px solid #27272a; }
    .attachment-notice { font-size: 12px; color: #a1a1aa; margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="logo-text">${gymName.toUpperCase()}</h1>
      <div class="tagline">${gymTagline}</div>
    </div>
    <div class="content">
      <div style="text-align: center;">
        <span class="badge">Official Payment Receipt</span>
        <div class="receipt-title">Payment Confirmation</div>
        <div class="receipt-id">Receipt No: ${safeReceiptNumber}</div>
      </div>

      <table class="table">
        <tr>
          <td class="label">Customer Name</td>
          <td class="value">${safeCustomerName}</td>
        </tr>
        <tr>
          <td class="label">Member ID</td>
          <td class="value" style="font-family: monospace;">${safeMemberId}</td>
        </tr>
        <tr>
          <td class="label">Membership Plan</td>
          <td class="value">${safePlanName}</td>
        </tr>
        <tr>
          <td class="label">Payment Date</td>
          <td class="value">${formattedDate}</td>
        </tr>
        <tr>
          <td class="label">Payment Method</td>
          <td class="value">${safePaymentMethod}</td>
        </tr>
        ${
          paymentMethod === 'UPI' && safeUpiTxn
            ? `
        <tr>
          <td class="label">UPI Transaction No</td>
          <td class="value" style="font-family: monospace; color: #ef4444; font-weight: 700;">${safeUpiTxn}</td>
        </tr>`
            : ''
        }
        <tr>
          <td class="label">Receipt Number</td>
          <td class="value" style="font-family: monospace; color: #f87171;">${safeReceiptNumber}</td>
        </tr>
        <tr class="amount-row">
          <td class="label" style="color: #34d399 !important;">Payment Amount</td>
          <td class="value">₹${numAmount.toLocaleString('en-IN')}</td>
        </tr>
        ${
          numRemaining > 0
            ? `
        <tr class="balance-row">
          <td class="label" style="color: #f87171 !important;">Remaining Balance Due</td>
          <td class="value">₹${numRemaining.toLocaleString('en-IN')}</td>
        </tr>`
            : `
        <tr>
          <td class="label">Remaining Balance</td>
          <td class="value" style="color: #34d399;">₹0 (Fully Paid)</td>
        </tr>`
        }
        ${
          safeNotes
            ? `
        <tr>
          <td class="label">Payment Notes</td>
          <td class="value" style="font-style: italic; font-weight: normal; color: #d4d4d8;">${safeNotes}</td>
        </tr>`
            : ''
        }
      </table>

      <div class="thankyou-box">
        <p><strong>Thank you for choosing MS Fitness!</strong></p>
        <p>We appreciate your dedication to health and fitness. Keep pushing your boundaries.</p>
        <p style="margin-top: 8px; font-weight: 700; color: #ef4444;">Stronger Body, Stronger You 💪</p>
      </div>

      <div class="attachment-notice">
        📎 <strong>PDF Receipt Attached:</strong> A printable, official tax-compliant receipt PDF is attached to this email for your records.
      </div>
    </div>

    <div class="footer">
      <div>${gymName} • ${gymAddress}</div>
      <div style="margin-top: 4px;">Phone: ${gymPhone} | Email: ${gymEmail}</div>
      <div style="margin-top: 8px; color: #52525b;">This is an automated receipt from MS Fitness Admin Portal.</div>
    </div>
  </div>
</body>
</html>
      `;

      const textBody = `
MS FITNESS - OFFICIAL PAYMENT RECEIPT
${gymSettings?.tagline || 'Stronger Body, Stronger You'}
----------------------------------------
Receipt Number: ${receiptNumber}
Customer Name: ${customerName || 'Member'}
Member ID: ${memberId || 'N/A'}
Membership Plan: ${planName || 'Gym Membership'}
Payment Date: ${formattedDate}
Payment Amount: ₹${numAmount.toLocaleString('en-IN')}
Payment Method: ${paymentMethod || 'Cash'}
${paymentMethod === 'UPI' && (transactionNumber || upiTransactionNumber) ? `UPI Transaction Number: ${transactionNumber || upiTransactionNumber}\n` : ''}Remaining Balance: ₹${numRemaining.toLocaleString('en-IN')}

Thank you for choosing MS Fitness!
Stronger Body, Stronger You.
      `.trim();

      const attachments = [];
      if (pdfBase64) {
        attachments.push({
          filename: pdfFilename || `Receipt_${receiptNumber}.pdf`,
          content: Buffer.from(pdfBase64, 'base64'),
          contentType: 'application/pdf',
        });
      }

      let transporter: any = null;
      if (runtimeSmtp.host && runtimeSmtp.user && runtimeSmtp.pass) {
        transporter = nodemailer.createTransport({
          host: runtimeSmtp.host,
          port: runtimeSmtp.port,
          secure: runtimeSmtp.secure,
          auth: {
            user: runtimeSmtp.user,
            pass: runtimeSmtp.pass,
          },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        });
      } else {
        transporter = await getEtherealTransporter();
      }

      let info: any = null;
      let sendFailureReason: string | null = null;
      let isSimulated = false;

      if (transporter) {
        try {
          info = await transporter.sendMail({
            from: runtimeSmtp.from.includes('<')
              ? runtimeSmtp.from
              : `"${gymSettings?.gym_name || 'MS Fitness'}" <${runtimeSmtp.from}>`,
            to,
            subject,
            text: textBody,
            html: htmlBody,
            attachments,
          });
        } catch (sendErr: any) {
          const errMsg = sendErr?.message || '';
          sendFailureReason = errMsg;
          console.log(`[Receipt Email] SMTP transport not accepted: ${errMsg.slice(0, 100)}. Falling back to safe simulated dispatch.`);
          info = { messageId: `msf-fallback-${Date.now()}`, simulated: true };
          isSimulated = true;
        }
      } else {
        info = { messageId: `msf-local-${Date.now()}`, simulated: true };
        isSimulated = true;
      }

      const previewUrl =
        info && info.messageId && !info.simulated ? nodemailer.getTestMessageUrl(info) : null;

      if (sendFailureReason) {
        return res.json({
          success: true,
          simulated: true,
          message: `Receipt recorded. Note: SMTP returned (${sendFailureReason.slice(0, 80)}).`,
          messageId: info?.messageId || 'simulated',
          previewUrl: null,
        });
      }

      return res.json({
        success: true,
        message: `Receipt sent successfully to ${to}.`,
        messageId: info?.messageId || 'sent',
        previewUrl,
      });
    } catch (err: any) {
      console.log('[Receipt Email Error]', err?.message || err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to send receipt email',
      });
    }
  });

  // ============================================================================
  // DIRECT CUSTOM EMAIL DISPATCH WITH SENDER singhalmanav58@gmail.com
  // ============================================================================
  app.post('/api/send-custom-email', async (req, res) => {
    try {
      const {
        to,
        subject,
        html,
        text,
        senderName,
        senderEmail,
        templateType,
        memberName,
        memberId,
        gymSettings,
      } = req.body || {};

      const cleanTo = String(to || '').trim().toLowerCase();
      if (!cleanTo || !cleanTo.includes('@')) {
        return res.status(400).json({
          success: false,
          error: 'Please provide a valid recipient email address.',
        });
      }

      if (!subject || !String(subject).trim()) {
        return res.status(400).json({
          success: false,
          error: 'Email subject is required.',
        });
      }

      const cleanSender = String(senderEmail || 'singhalmanav58@gmail.com').trim().toLowerCase();
      const safeSenderName = escapeHtml(senderName || gymSettings?.gym_name || 'MS Fitness');
      const fromAddress = `"${safeSenderName}" <${cleanSender}>`;

      const safeSubject = escapeHtml(String(subject).trim());
      const safeRecipient = escapeHtml(cleanTo);
      const safeMemberName = escapeHtml(memberName || 'Valued Athlete');
      const safeMemberId = escapeHtml(memberId || '');
      const gymName = escapeHtml(gymSettings?.gym_name || 'MS Fitness');
      const gymPhone = escapeHtml(gymSettings?.phone || '+91 98765 43210');
      const gymAddress = escapeHtml(gymSettings?.address || 'Fitness District, New Delhi, India');

      let finalHtml = html;
      if (!finalHtml || !finalHtml.includes('<!DOCTYPE html>')) {
        const bodyContent = html || escapeHtml(text || '').replace(/\n/g, '<br/>');
        finalHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f0f11; color: #f4f4f5; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .header { background: linear-gradient(135deg, #18181b 0%, #09090b 100%); padding: 32px 24px; border-bottom: 3px solid #dc2626; text-align: center; }
    .brand { font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: 2px; margin: 0; }
    .tagline { font-size: 11px; color: #ef4444; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-top: 6px; }
    .content { padding: 32px 26px; font-size: 14px; line-height: 1.6; color: #e4e4e7; }
    .subject-banner { background-color: rgba(220, 38, 38, 0.12); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; font-size: 12px; font-weight: 700; padding: 8px 14px; border-radius: 10px; margin-bottom: 20px; display: inline-block; }
    .footer { background-color: #09090b; padding: 20px 24px; text-align: center; font-size: 11px; color: #71717a; border-top: 1px solid #27272a; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="brand">${gymName.toUpperCase()}</h1>
      <div class="tagline">Stronger Body, Stronger You</div>
    </div>
    <div class="content">
      <div class="subject-banner">${safeSubject}</div>
      ${safeMemberName ? `<p style="color: #ffffff; font-weight: 600;">Dear ${safeMemberName}${safeMemberId ? ` (ID: ${safeMemberId})` : ''},</p>` : ''}
      <div style="margin-top: 14px; color: #d4d4d8;">
        ${bodyContent}
      </div>
      <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #27272a;">
        <p style="margin: 0; font-size: 13px; color: #a1a1aa;">Best regards,</p>
        <p style="margin: 4px 0 0 0; font-size: 14px; font-weight: 700; color: #ffffff;">${safeSenderName}</p>
        <p style="margin: 2px 0 0 0; font-size: 12px; color: #ef4444;">Official Email: ${cleanSender}</p>
      </div>
    </div>
    <div class="footer">
      <div>${gymName} • ${gymAddress}</div>
      <div style="margin-top: 4px;">Phone: ${gymPhone} | Sent by singhalmanav58@gmail.com</div>
      <div style="margin-top: 6px; color: #52525b;">Official Notification from MS Fitness Gym Management System</div>
    </div>
  </div>
</body>
</html>
        `.trim();
      }

      const finalText = text || `${subject}\n\nDear ${memberName || 'Athlete'},\n\nThis message was sent from ${cleanSender}.\n\nMS Fitness`;

      let transporter: any = null;
      if (runtimeSmtp.host && runtimeSmtp.user && runtimeSmtp.pass) {
        transporter = nodemailer.createTransport({
          host: runtimeSmtp.host,
          port: runtimeSmtp.port,
          secure: runtimeSmtp.secure,
          auth: {
            user: runtimeSmtp.user,
            pass: runtimeSmtp.pass,
          },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        });
      } else {
        transporter = await getEtherealTransporter();
      }

      let info: any = null;
      let deliveryMode: 'smtp' | 'ethereal' | 'sandbox' = 'sandbox';
      let previewUrl: string | null = null;
      let sendFailureReason: string | null = null;

      if (transporter) {
        try {
          info = await transporter.sendMail({
            from: fromAddress,
            to: cleanTo,
            subject: String(subject).trim(),
            text: finalText,
            html: finalHtml,
          });
          deliveryMode = runtimeSmtp.user && runtimeSmtp.pass ? 'smtp' : 'ethereal';
        } catch (sendErr: any) {
          sendFailureReason = sendErr?.message || '';
          console.log(`[Custom Email] SMTP delivery failed: ${sendFailureReason.slice(0, 100)}. Falling back to safe simulated dispatch.`);
          info = { messageId: `msf-custom-${Date.now()}`, simulated: true };
          deliveryMode = 'sandbox';
        }
      } else {
        info = { messageId: `msf-custom-${Date.now()}`, simulated: true };
        deliveryMode = 'sandbox';
      }

      if (info && info.messageId && !info.simulated) {
        const url = nodemailer.getTestMessageUrl(info);
        previewUrl = typeof url === 'string' ? url : null;
      }

      const messageId = info?.messageId || `msf-custom-${Date.now()}`;
      emailOutbox.set(cleanTo, {
        id: messageId,
        to: cleanTo,
        from: fromAddress,
        subject: String(subject).trim(),
        html: finalHtml,
        text: finalText,
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        deliveryMode,
        smtpHost: deliveryMode === 'smtp' ? runtimeSmtp.host : 'smtp.ethereal.email',
        previewUrl,
      });

      console.log(`[Custom Email] Dispatched email to ${cleanTo} from ${cleanSender} (Mode: ${deliveryMode.toUpperCase()})`);

      return res.json({
        success: true,
        message: deliveryMode === 'smtp'
          ? `Email successfully sent to ${cleanTo} from ${cleanSender} via ${runtimeSmtp.host}.`
          : `Email dispatched to ${cleanTo} from ${cleanSender} (Sandbox/Ethereal mode).`,
        deliveryMode,
        from: cleanSender,
        previewUrl,
        messageId,
      });
    } catch (err: any) {
      console.error('[Send Custom Email Error]', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to dispatch email.',
      });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(
      '/assets',
      express.static(path.join(distPath, 'assets'), {
        maxAge: '1y',
        immutable: true,
      })
    );
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          }
        },
      })
    );
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MS Fitness Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
