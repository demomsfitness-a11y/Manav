import { getSupabase, isSupabaseConfigured } from './supabase';
import { Session, User } from '@supabase/supabase-js';

export interface EmailValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

export interface DispatchedOtpEmail {
  id: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  sentAt: string;
  expiresAt: string;
  deliveryMode: 'smtp' | 'ethereal' | 'sandbox';
  smtpHost: string;
  previewUrl: string | null;
  otpCodePreview?: string;
}

export interface SendEmailOtpResult {
  success: boolean;
  email: string;
  message: string;
  deliveryMode: 'smtp' | 'ethereal' | 'sandbox';
  messageId?: string;
  previewUrl?: string | null;
  smtpNotice?: string | null;
  expiresInSeconds: number;
  cooldownSeconds: number;
  dispatchedEmail?: DispatchedOtpEmail | null;
}

export interface SmtpStatusInfo {
  configured: boolean;
  mode: 'smtp' | 'sandbox';
  host: string;
  port: number;
  user: string;
  from: string;
  secure: boolean;
}

export class AuthRateLimitError extends Error {
  seconds: number;
  dispatchedEmail?: DispatchedOtpEmail | null;
  constructor(message: string, seconds: number = 30, dispatchedEmail?: DispatchedOtpEmail | null) {
    super(message);
    this.name = 'AuthRateLimitError';
    this.seconds = seconds;
    this.dispatchedEmail = dispatchedEmail;
  }
}

export class AuthEmailQuotaExceededError extends Error {
  code = 'over_email_send_rate_limit';
  constructor(message?: string) {
    super(
      message ||
        'Email rate limit reached. Please use the built-in Email OTP system or configure Custom SMTP.'
    );
    this.name = 'AuthEmailQuotaExceededError';
  }
}

const OTP_COOLDOWN_SECONDS = 30;
const SESSION_TOKEN_STORAGE_KEY = 'msf_otp_session_token';

/**
 * Returns remaining cooldown seconds for an email (0 if ready to send).
 */
export function getRemainingOtpCooldown(email: string): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  try {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return 0;
    const stored = localStorage.getItem(`msf_otp_last_sent_${cleanEmail}`);
    if (!stored) return 0;
    const lastSent = Number(stored);
    if (!lastSent || isNaN(lastSent)) return 0;
    const elapsed = Math.floor((Date.now() - lastSent) / 1000);
    if (elapsed < 0) return 0;
    const remaining = OTP_COOLDOWN_SECONDS - elapsed;
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

/**
 * Records an OTP send event with current timestamp.
 */
export function recordOtpSent(email: string, _seconds: number = OTP_COOLDOWN_SECONDS): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return;
    localStorage.setItem(`msf_otp_last_sent_${cleanEmail}`, String(Date.now()));
    localStorage.setItem('msf_pending_otp_email', cleanEmail);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Validates and normalizes email address.
 */
export function validateEmail(input: string): EmailValidationResult {
  const normalized = (input || '').trim().toLowerCase();

  if (!normalized) {
    return {
      valid: false,
      normalized: '',
      error: 'Please enter a valid email address.',
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Please enter a valid email address.',
    };
  }

  return {
    valid: true,
    normalized,
  };
}

/**
 * Maps authentication errors into friendly, non-technical user messages.
 */
export function mapSupabaseAuthError(error: any, context: 'send' | 'verify'): string {
  if (!error) {
    return context === 'send'
      ? 'Unable to send OTP. Please try again.'
      : 'Invalid OTP. Please check the code and try again.';
  }

  const msg = String(error.message || error.error_description || error || '').toLowerCase();
  const status = error.status || error.statusCode;

  if (
    msg.includes('rate limit') ||
    msg.includes('too many') ||
    msg.includes('wait') ||
    status === 429
  ) {
    const match = msg.match(/(\d+)\s*seconds/i);
    const secs = match && match[1] ? parseInt(match[1], 10) : 30;
    return `Please wait ${secs} seconds before requesting another verification code.`;
  }

  if (
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('offline')
  ) {
    return 'Connection problem. Please try again.';
  }

  if (context === 'verify') {
    if (msg.includes('expired') || (error as any)?.code === 'otp_expired') {
      return 'This verification code has expired. Please request a new 6-digit code.';
    }
    if (msg.includes('attempt') || (error as any)?.code === 'otp_max_attempts') {
      return error.message || 'Maximum verification attempts exceeded. Please request a new code.';
    }
    return error.message || 'Incorrect verification code. Please check the 6 digits from your email.';
  }

  return error.message || 'Unable to send OTP. Please try again.';
}

/**
 * Primary Server-Side Email OTP Dispatcher (`/api/auth/send-otp`).
 * Generates a cryptographically secure 6-digit OTP on the backend and dispatches via
 * configured SMTP or Ethereal/Sandbox inbox.
 */
export async function sendEmailOtp(
  email: string,
  options?: { forceResend?: boolean }
): Promise<SendEmailOtpResult> {
  const validation = validateEmail(email);
  if (!validation.valid) {
    throw new Error(validation.error || 'Please enter a valid email address.');
  }

  const response = await fetch('/api/auth/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: validation.normalized,
      forceResend: Boolean(options?.forceResend),
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    if (response.status === 429) {
      const secs = Number(data.cooldownSeconds) || 30;
      throw new AuthRateLimitError(
        data.error || `Please wait ${secs} seconds before requesting another code.`,
        secs,
        data.dispatchedEmail || null
      );
    }
    throw new Error(data.error || 'Failed to send verification email.');
  }

  recordOtpSent(validation.normalized, data.cooldownSeconds || OTP_COOLDOWN_SECONDS);

  return {
    success: true,
    email: validation.normalized,
    message: data.message || 'Verification code sent to your email.',
    deliveryMode: data.deliveryMode || 'sandbox',
    messageId: data.messageId,
    previewUrl: data.previewUrl || null,
    smtpNotice: data.smtpNotice || null,
    expiresInSeconds: Number(data.expiresInSeconds) || 600,
    cooldownSeconds: Number(data.cooldownSeconds) || 30,
    dispatchedEmail: data.dispatchedEmail || null,
  };
}

/**
 * Backwards-compatible wrapper for sendEmailOtp.
 */
export async function sendSupabaseEmailOtp(email: string): Promise<SendEmailOtpResult> {
  return sendEmailOtp(email);
}

/**
 * Fetches the latest dispatched verification email from the server outbox for inspection.
 */
export async function fetchLatestDispatchedEmail(email: string): Promise<DispatchedOtpEmail | null> {
  try {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return null;
    const res = await fetch(`/api/auth/outbox?email=${encodeURIComponent(cleanEmail)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.dispatchedEmail || null;
  } catch {
    return null;
  }
}

/**
 * Verifies a 6-digit OTP against the server-side cryptographic OTP engine,
 * with fallback to Supabase Auth OTP if the user entered a code from Supabase GoTrue.
 */
export async function verifySupabaseEmailOtp(
  email: string,
  otpCode: string
): Promise<{ session: Session; user: User }> {
  const validation = validateEmail(email);
  if (!validation.valid) {
    throw new Error(validation.error || 'Please enter a valid email address.');
  }

  const cleanOtp = (otpCode || '').replace(/\s+/g, '').trim();
  if (!cleanOtp || !/^\d{6}$/.test(cleanOtp)) {
    throw new Error('Please enter a complete 6-digit numeric OTP.');
  }

  // 1. Primary verification against Server-Side Email OTP Engine (`/api/auth/verify-otp`)
  const serverRes = await fetch('/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: validation.normalized,
      otp: cleanOtp,
    }),
  });

  const serverData = await serverRes.json();

  if (serverRes.ok && serverData.success && serverData.verified) {
    if (serverData.sessionToken && typeof window !== 'undefined') {
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, serverData.sessionToken);
    }

    const verifiedUser = {
      id: `otp-user-${validation.normalized}`,
      email: validation.normalized,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
    } as unknown as User;

    const verifiedSession = {
      access_token: serverData.sessionToken || 'msf_server_otp_session',
      token_type: 'bearer',
      expires_in: 86400,
      expires_at: Math.floor((serverData.expiresAt || Date.now() + 86400000) / 1000),
      refresh_token: '',
      user: verifiedUser,
    } as Session;

    return {
      session: verifiedSession,
      user: verifiedUser,
    };
  }

  // 2. If server OTP returned 'otp_not_found' or 'otp_invalid' and Supabase is configured,
  // also check if the code came from Supabase Auth's GoTrue service
  const client = getSupabase();
  if (client && isSupabaseConfigured() && serverData.code !== 'otp_max_attempts') {
    try {
      const { data, error } = await client.auth.verifyOtp({
        email: validation.normalized,
        token: cleanOtp,
        type: 'email',
      });
      if (!error && data?.session && data?.user) {
        return {
          session: data.session,
          user: data.user,
        };
      }
    } catch {
      // Fall through to server error message
    }
  }

  throw new Error(serverData.error || 'Incorrect verification code. Please check the 6 digits and try again.');
}

/**
 * Verifies if the client holds a valid signed Server OTP session token.
 */
export async function verifyServerOtpSession(): Promise<{ valid: boolean; email?: string }> {
  if (typeof window === 'undefined') return { valid: false };
  const token = localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  if (!token) return { valid: false };

  try {
    const res = await fetch('/api/auth/verify-session', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      return { valid: false };
    }
    const data = await res.json();
    if (data.valid && data.email) {
      return { valid: true, email: String(data.email).toLowerCase().trim() };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/**
 * Fetches current SMTP configuration status from the server.
 */
export async function fetchSmtpStatus(): Promise<SmtpStatusInfo> {
  const res = await fetch('/api/auth/smtp-status');
  const data = await res.json();
  return {
    configured: Boolean(data.configured),
    mode: data.mode === 'smtp' ? 'smtp' : 'sandbox',
    host: data.host || 'smtp.gmail.com',
    port: Number(data.port) || 465,
    user: data.user || 'singhalmanav58@gmail.com',
    from: data.from || 'MS Fitness <singhalmanav58@gmail.com>',
    secure: Boolean(data.secure),
  };
}

/**
 * Updates and optionally tests SMTP configuration on the backend.
 */
export async function updateSmtpConfig(config: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure?: boolean;
  testConnection?: boolean;
}): Promise<{ success: boolean; configured: boolean; mode: 'smtp' | 'sandbox'; message: string }> {
  const res = await fetch('/api/auth/smtp-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update SMTP configuration.');
  }
  return data;
}

/**
 * Signs out the authenticated user from both Server OTP Session and Supabase Auth.
 */
export async function signOutSupabase(): Promise<void> {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  }
  const client = getSupabase();
  if (client) {
    try {
      await client.auth.signOut();
    } catch (err) {
      console.warn('Sign out warning:', err);
    }
  }
}
