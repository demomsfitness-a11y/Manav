import React, { useState, useEffect, useRef } from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  validateEmail,
  sendEmailOtp,
  verifySupabaseEmailOtp,
  signOutSupabase,
  AuthRateLimitError,
  getRemainingOtpCooldown,
  recordOtpSent,
  fetchLatestDispatchedEmail,
  fetchSmtpStatus,
  updateSmtpConfig,
  DispatchedOtpEmail,
  SmtpStatusInfo,
} from '../lib/auth';
import { fetchAdminByEmail, updateAdminLastLogin, logActivity } from '../lib/db';
import { AdminAccount } from '../types';
import {
  Dumbbell,
  Mail,
  KeyRound,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  RefreshCw,
  Database,
  CheckCircle2,
  Clock,
  RotateCcw,
  FileCode,
  Inbox,
  Server,
  ExternalLink,
  Copy,
  Check,
  Eye,
  EyeOff,
  X,
  Lock,
} from 'lucide-react';

interface Props {
  onLoginSuccess: (admin: AdminAccount) => void;
  onOpenConfig: () => void;
  onOpenSql: () => void;
  onOpenBooking?: () => void;
}

export const LoginView: React.FC<Props> = ({
  onLoginSuccess,
  onOpenConfig,
  onOpenSql,
}) => {
  const [email, setEmail] = useState(() => {
    return localStorage.getItem('msf_pending_otp_email') || 'singhalmanav58@gmail.com';
  });
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [step, setStep] = useState<'email' | 'otp'>('email');

  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // Dispatched email & inbox inspector state
  const [dispatchedEmail, setDispatchedEmail] = useState<DispatchedOtpEmail | null>(null);
  const [showEmailInspector, setShowEmailInspector] = useState<boolean>(false);
  const [copiedOtp, setCopiedOtp] = useState<boolean>(false);

  // SMTP configuration state
  const [smtpStatus, setSmtpStatus] = useState<SmtpStatusInfo | null>(null);
  const [isSmtpModalOpen, setIsSmtpModalOpen] = useState<boolean>(false);
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpUser, setSmtpUser] = useState('singhalmanav58@gmail.com');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('MS Fitness <singhalmanav58@gmail.com>');
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [smtpFeedback, setSmtpFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Timers: 30s resend cooldown + 10-minute OTP expiration countdown
  const [resendCountdown, setResendCountdown] = useState<number>(0);
  const [expiryCountdown, setExpiryCountdown] = useState<number>(600);
  const resendTimerRef = useRef<NodeJS.Timeout | null>(null);
  const expiryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isConfigured = isSupabaseConfigured();
  const otpString = otpDigits.join('');

  const startResendTimer = (initialSeconds: number) => {
    if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    setResendCountdown(initialSeconds);

    resendTimerRef.current = setInterval(() => {
      setResendCountdown((prev) => {
        if (prev <= 1) {
          if (resendTimerRef.current) clearInterval(resendTimerRef.current);
          resendTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const startExpiryTimer = (initialSeconds: number) => {
    if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    setExpiryCountdown(initialSeconds);

    expiryTimerRef.current = setInterval(() => {
      setExpiryCountdown((prev) => {
        if (prev <= 1) {
          if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
          expiryTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const formatMinutesSeconds = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Load SMTP status and any pending OTP state on mount
  useEffect(() => {
    fetchSmtpStatus()
      .then((status) => {
        setSmtpStatus(status);
        setSmtpHost(status.host || 'smtp.gmail.com');
        setSmtpPort(status.port || 465);
        setSmtpUser(status.user || 'singhalmanav58@gmail.com');
        setSmtpFrom(status.from || 'MS Fitness <singhalmanav58@gmail.com>');
      })
      .catch(() => {});

    const savedEmail = localStorage.getItem('msf_pending_otp_email');
    if (savedEmail) {
      const remaining = getRemainingOtpCooldown(savedEmail);
      if (remaining > 0) {
        setEmail(savedEmail);
        startResendTimer(remaining);
      }
    }

    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
      if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    };
  }, []);

  // Focus first OTP box when entering 'otp' step
  useEffect(() => {
    if (step === 'otp') {
      setTimeout(() => {
        digitRefs.current[0]?.focus();
      }, 60);
    }
  }, [step]);

  // Handle individual digit input change
  const handleDigitChange = (index: number, value: string) => {
    if (errorMsg) setErrorMsg(null);
    const clean = value.replace(/\D/g, '');

    if (!clean) {
      const next = [...otpDigits];
      next[index] = '';
      setOtpDigits(next);
      return;
    }

    // If user typed or pasted multiple digits into a single box
    if (clean.length > 1) {
      const chars = clean.slice(0, 6).split('');
      const next = [...otpDigits];
      for (let i = 0; i < 6; i++) {
        next[i] = chars[i] || next[i] || '';
      }
      setOtpDigits(next);
      const focusIdx = Math.min(chars.length, 5);
      digitRefs.current[focusIdx]?.focus();
      return;
    }

    const next = [...otpDigits];
    next[index] = clean;
    setOtpDigits(next);

    if (index < 5) {
      digitRefs.current[index + 1]?.focus();
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!otpDigits[index] && index > 0) {
        const next = [...otpDigits];
        next[index - 1] = '';
        setOtpDigits(next);
        digitRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      digitRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      digitRefs.current[index + 1]?.focus();
    }
  };

  const handlePasteOtp = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setOtpDigits(next);
    if (errorMsg) setErrorMsg(null);
    const focusIdx = Math.min(pasted.length, 5);
    digitRefs.current[focusIdx]?.focus();
  };

  // Step 1: Send 6-Digit Email OTP
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const validation = validateEmail(email);
    if (!validation.valid) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }

    const cleanEmail = validation.normalized;

    if (cleanEmail === 'admin@msfitness.com') {
      const err =
        'Access Denied: The account "admin@msfitness.com" has been permanently blocked by the Super Administrator.';
      setErrorMsg(err);
      await logActivity(
        'Blocked Login Attempt',
        'Blocked account attempted sign-in: admin@msfitness.com',
        'admin@msfitness.com',
        { module: 'Auth', status: 'failed' }
      );
      return;
    }

    setIsSendingOtp(true);

    try {
      const res = await sendEmailOtp(cleanEmail);
      setOtpDigits(['', '', '', '', '', '']);
      setStep('otp');
      startResendTimer(res.cooldownSeconds || 30);
      startExpiryTimer(res.expiresInSeconds || 600);

      if (res.dispatchedEmail) {
        setDispatchedEmail(res.dispatchedEmail);
        // Automatically open the email inspector if SMTP is in sandbox/ethereal mode so user sees their OTP immediately
        if (res.deliveryMode !== 'smtp') {
          setShowEmailInspector(true);
        }
      }

      setInfoMsg(res.message);
    } catch (err: any) {
      if (err instanceof AuthRateLimitError) {
        const secs = err.seconds || 30;
        recordOtpSent(cleanEmail, secs);
        startResendTimer(secs);
        if (err.dispatchedEmail) {
          setDispatchedEmail(err.dispatchedEmail);
        } else {
          const latest = await fetchLatestDispatchedEmail(cleanEmail);
          if (latest) setDispatchedEmail(latest);
        }
        setStep('otp');
        setInfoMsg(
          `A verification code was already sent to ${cleanEmail}. You can enter it below or request a new code in ${secs}s.`
        );
      } else {
        setErrorMsg(err.message || 'Unable to send OTP. Please try again.');
      }
    } finally {
      setIsSendingOtp(false);
    }
  };

  // Resend OTP handler
  const handleResendOtp = async () => {
    if (resendCountdown > 0 || isSendingOtp || isVerifyingOtp) return;

    setErrorMsg(null);
    setInfoMsg(null);

    const validation = validateEmail(email);
    if (!validation.valid) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }

    setIsSendingOtp(true);

    try {
      const res = await sendEmailOtp(validation.normalized, { forceResend: true });
      setOtpDigits(['', '', '', '', '', '']);
      startResendTimer(res.cooldownSeconds || 30);
      startExpiryTimer(res.expiresInSeconds || 600);
      if (res.dispatchedEmail) {
        setDispatchedEmail(res.dispatchedEmail);
        if (res.deliveryMode !== 'smtp') {
          setShowEmailInspector(true);
        }
      }
      setInfoMsg('A fresh 6-digit verification code has been dispatched.');
      digitRefs.current[0]?.focus();
    } catch (err: any) {
      setErrorMsg(err.message || 'Unable to resend OTP. Please try again.');
    } finally {
      setIsSendingOtp(false);
    }
  };

  // Auto-fill OTP from the Sent Email Inspector (when in Sandbox / Ethereal mode)
  const handleAutoFillFromOutbox = (codeToFill: string) => {
    const clean = codeToFill.replace(/\D/g, '').slice(0, 6);
    if (clean.length === 6) {
      setOtpDigits(clean.split(''));
      setErrorMsg(null);
      setCopiedOtp(true);
      setTimeout(() => setCopiedOtp(false), 2000);
    }
  };

  // Step 2: Verify 6-Digit OTP & Check Admin Authorization
  const handleVerifyOtp = async (e?: React.FormEvent, codeOverride?: string) => {
    if (e) e.preventDefault();
    setErrorMsg(null);

    const validation = validateEmail(email);
    if (!validation.valid) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }

    const cleanOtp = (codeOverride || otpString).replace(/\s+/g, '').trim();
    if (!cleanOtp || cleanOtp.length !== 6) {
      setErrorMsg('Please enter all 6 digits of your verification code.');
      return;
    }

    setIsVerifyingOtp(true);

    try {
      const { session, user } = await verifySupabaseEmailOtp(validation.normalized, cleanOtp);
      const authenticatedEmail = (
        user?.email ||
        session?.user?.email ||
        validation.normalized
      )
        .toLowerCase()
        .trim();

      // Verify Admin Authorization against Admin/Staff roster
      const adminRecord = await fetchAdminByEmail(authenticatedEmail);

      if (!adminRecord) {
        await signOutSupabase();
        await logActivity(
          'Unauthorized Admin Login Attempt',
          `Unauthorized sign-in attempt from ${authenticatedEmail}`,
          authenticatedEmail,
          { module: 'Auth', status: 'failed' }
        );
        setErrorMsg(
          `Account "${authenticatedEmail}" is not registered in the MS Fitness Admin Roster.`
        );
        return;
      }

      if (adminRecord.status === 'inactive') {
        await signOutSupabase();
        await logActivity(
          'Unauthorized Admin Login Attempt',
          `Deactivated administrator account attempted login: ${authenticatedEmail}`,
          authenticatedEmail,
          { module: 'Auth', status: 'failed' }
        );
        setErrorMsg('This administrator account has been deactivated.');
        return;
      }

      localStorage.removeItem('msf_pending_otp_email');
      localStorage.setItem('ms_fitness_admin_session', adminRecord.email);
      localStorage.setItem('msf_admin_email', adminRecord.email);
      localStorage.setItem('msf_current_admin', JSON.stringify(adminRecord));
      await updateAdminLastLogin(adminRecord.email);

      await logActivity(
        'Admin Email OTP Login',
        `Admin authenticated via 6-digit Email OTP: ${adminRecord.full_name} (${adminRecord.role})`,
        adminRecord,
        {
          module: 'Auth',
          status: 'success',
          target_type: 'admin',
          target_id: adminRecord.admin_id,
        }
      );

      onLoginSuccess(adminRecord);
    } catch (err: any) {
      console.error('Verify OTP failure:', err);
      setErrorMsg(err.message || 'Incorrect verification code. Please check the 6 digits and try again.');
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  // Save & Test SMTP Configuration
  const handleSaveSmtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSmtp(true);
    setSmtpFeedback(null);

    try {
      const res = await updateSmtpConfig({
        host: smtpHost,
        port: Number(smtpPort) || 465,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom,
        secure: Number(smtpPort) === 465,
        testConnection: Boolean(smtpUser && smtpPass),
      });

      const updatedStatus = await fetchSmtpStatus();
      setSmtpStatus(updatedStatus);
      setSmtpFeedback({
        type: 'success',
        text: res.message,
      });
    } catch (err: any) {
      setSmtpFeedback({
        type: 'error',
        text: err.message || 'Failed to verify SMTP settings.',
      });
    } finally {
      setSavingSmtp(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col justify-center items-center p-4 relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-red-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Main Login Card */}
      <div className="w-full max-w-md bg-neutral-900/95 border border-neutral-800 rounded-3xl p-7 sm:p-8 shadow-2xl backdrop-blur-xl relative z-10 animate-in fade-in zoom-in-95 duration-200">
        {/* Brand Header */}
        <div className="text-center space-y-2 mb-6">
          <div className="w-14 h-14 bg-gradient-to-br from-red-600 to-red-700 rounded-2xl flex items-center justify-center text-white mx-auto shadow-xl shadow-red-600/30">
            <Dumbbell className="w-8 h-8" />
          </div>

          <div>
            <h1 className="text-3xl font-extrabold text-white tracking-wider font-display leading-none">
              MS FITNESS
            </h1>
            <p className="text-[11px] font-bold text-red-500 tracking-widest uppercase mt-1">
              STRONGER BODY, STRONGER YOU
            </p>
          </div>

          <div className="pt-1.5">
            <h2 className="text-sm font-bold text-white tracking-wide">
              Email OTP Authentication Portal
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Zero-trust 6-digit one-time passcode verification for authorized staff
            </p>
          </div>
        </div>

        {/* Email OTP Delivery Status Bar */}
        <div className="mb-5 px-3.5 py-2.5 rounded-2xl bg-neutral-950 border border-neutral-800/90 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-neutral-300">
            <span
              className={`w-2 h-2 rounded-full ${
                smtpStatus?.configured ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="text-neutral-400">
              Mail Engine:{' '}
              <strong className="text-white">
                {smtpStatus?.configured ? `Live SMTP (${smtpStatus.host})` : 'Built-in OTP Inbox'}
              </strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setSmtpFeedback(null);
              setIsSmtpModalOpen(true);
            }}
            className="text-red-400 hover:text-red-300 font-semibold underline text-[11px] cursor-pointer"
          >
            SMTP Settings
          </button>
        </div>

        {/* Supabase status notice banner if unconfigured */}
        {!isConfigured && (
          <div className="mb-5 p-3.5 rounded-2xl bg-amber-950/40 border border-amber-800/60 text-amber-200 text-xs space-y-1.5">
            <div className="flex items-center justify-between font-semibold">
              <span className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-amber-400" /> Supabase Config
              </span>
              <button
                type="button"
                onClick={onOpenConfig}
                className="text-amber-400 hover:text-white underline text-[11px]"
              >
                Configure
              </button>
            </div>
            <p className="text-[11px] text-amber-300/80 leading-relaxed">
              Connect your Supabase project to sync cloud database records.
            </p>
          </div>
        )}

        {/* Error notification */}
        {errorMsg && (
          <div className="mb-5 p-3.5 rounded-2xl bg-red-950/60 border border-red-800/70 text-red-200 text-xs space-y-2 animate-in fade-in duration-150">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">{errorMsg}</p>
            </div>
          </div>
        )}

        {/* Info notification */}
        {infoMsg && (
          <div className="mb-5 p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{infoMsg}</p>
          </div>
        )}

        {/* STEP 1: Enter Admin Email Address */}
        {step === 'email' ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-red-500" /> Administrator Email
                </label>
                {email.toLowerCase() !== 'singhalmanav58@gmail.com' && (
                  <button
                    type="button"
                    onClick={() => setEmail('singhalmanav58@gmail.com')}
                    className="text-[11px] text-neutral-400 hover:text-red-400 transition-colors cursor-pointer"
                  >
                    Use Super Admin Email
                  </button>
                )}
              </div>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="Enter registered admin email"
                className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-2xl px-4 py-3 text-sm text-white placeholder-neutral-600 outline-none transition-all"
                autoFocus
              />
              <p className="text-[11px] text-neutral-500 mt-1.5 leading-relaxed">
                A cryptographic 6-digit one-time verification code (valid for 10 minutes) will be generated and sent to this address.
              </p>
            </div>

            <button
              type="submit"
              disabled={isSendingOtp}
              className="w-full py-3.5 rounded-2xl bg-red-600 hover:bg-red-700 active:scale-[0.99] text-white font-bold text-sm tracking-wide transition-all shadow-xl shadow-red-600/30 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSendingOtp ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Generating &amp; Sending OTP...</span>
                </>
              ) : (
                <>
                  <span>Send 6-Digit Email OTP</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            {/* Direct transition if code was already received */}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={async () => {
                  const validation = validateEmail(email);
                  if (!validation.valid) {
                    setErrorMsg('Please enter your email address first.');
                    return;
                  }
                  setErrorMsg(null);
                  const latest = await fetchLatestDispatchedEmail(validation.normalized);
                  if (latest) setDispatchedEmail(latest);
                  setStep('otp');
                }}
                className="text-xs text-neutral-400 hover:text-white transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <KeyRound className="w-3.5 h-3.5 text-red-500" />
                <span>
                  Already have a 6-digit code? <strong className="text-neutral-200">Enter Code</strong>
                </span>
              </button>
            </div>
          </form>
        ) : (
          /* STEP 2: Enter 6-Digit Segmented OTP Code */
          <form onSubmit={(e) => handleVerifyOtp(e)} className="space-y-5">
            <div className="text-center space-y-1">
              <div className="flex items-center justify-between text-xs text-neutral-400 bg-neutral-950 border border-neutral-800 rounded-xl px-3.5 py-2">
                <span className="font-mono text-white truncate max-w-[210px]">{email}</span>
                <button
                  type="button"
                  onClick={() => {
                    setStep('email');
                    setErrorMsg(null);
                    setInfoMsg(null);
                  }}
                  className="text-red-400 hover:text-red-300 font-semibold cursor-pointer shrink-0 ml-2"
                >
                  Change Email
                </button>
              </div>
            </div>

            {/* 6-Digit Segmented OTP Boxes */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-red-500" /> 6-Digit Verification Code
                </label>
                <span className="text-[11px] font-mono text-neutral-400 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-red-400" />
                  Expires in{' '}
                  <strong className={expiryCountdown < 60 ? 'text-red-400' : 'text-neutral-200'}>
                    {formatMinutesSeconds(expiryCountdown)}
                  </strong>
                </span>
              </div>

              <div
                className="grid grid-cols-6 gap-2 sm:gap-2.5"
                onPaste={handlePasteOtp}
              >
                {otpDigits.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => {
                      digitRefs.current[idx] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={digit}
                    onChange={(e) => handleDigitChange(idx, e.target.value)}
                    onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                    aria-label={`OTP digit ${idx + 1}`}
                    className={`w-full h-12 sm:h-14 rounded-xl bg-neutral-950 border text-center text-xl font-bold font-mono text-white outline-none transition-all ${
                      digit
                        ? 'border-red-500/80 ring-1 ring-red-500/30 bg-red-950/10'
                        : 'border-neutral-800 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Verify OTP Button */}
            <button
              type="submit"
              disabled={isVerifyingOtp || isSendingOtp || otpString.length !== 6}
              className="w-full py-3.5 rounded-2xl bg-red-600 hover:bg-red-700 active:scale-[0.99] text-white font-bold text-sm tracking-wide transition-all shadow-xl shadow-red-600/30 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isVerifyingOtp ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Verifying Code...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Verify &amp; Sign In</span>
                </>
              )}
            </button>

            {/* Resend OTP Controls */}
            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-neutral-400">Didn&apos;t receive the email?</span>
              {resendCountdown > 0 ? (
                <span className="text-neutral-400 font-mono">
                  Resend available in <strong className="text-white">{resendCountdown}s</strong>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={isSendingOtp || isVerifyingOtp}
                  className="inline-flex items-center gap-1.5 font-semibold text-red-400 hover:text-red-300 underline transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{isSendingOtp ? 'Sending...' : 'Resend New OTP'}</span>
                </button>
              )}
            </div>

            {/* Live Sent Email Inspector / Outbox Card */}
            {dispatchedEmail && (
              <div className="mt-4 rounded-2xl bg-neutral-950 border border-neutral-800 overflow-hidden text-xs">
                <div className="p-3.5 flex items-center justify-between bg-neutral-900/70 border-b border-neutral-800/80">
                  <div className="flex items-center gap-2">
                    <Inbox className="w-4 h-4 text-red-400 shrink-0" />
                    <div>
                      <p className="font-semibold text-white">
                        {dispatchedEmail.deliveryMode === 'smtp'
                          ? 'Dispatched via Live SMTP'
                          : 'Built-in Email OTP Outbox'}
                      </p>
                      <p className="text-[11px] text-neutral-400">
                        Sent to {dispatchedEmail.to}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowEmailInspector(!showEmailInspector)}
                    className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-medium text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    {showEmailInspector ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" /> Hide Email
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" /> View Sent Email
                      </>
                    )}
                  </button>
                </div>

                {showEmailInspector && (
                  <div className="p-3.5 space-y-3 animate-in fade-in duration-150">
                    <div className="space-y-1 text-[11px] text-neutral-400 bg-neutral-900/60 p-2.5 rounded-xl border border-neutral-800/70">
                      <div>
                        <span className="text-neutral-500">Subject:</span>{' '}
                        <strong className="text-neutral-200">{dispatchedEmail.subject}</strong>
                      </div>
                      <div>
                        <span className="text-neutral-500">Transport:</span>{' '}
                        <span className="font-mono text-neutral-300">{dispatchedEmail.smtpHost}</span>
                      </div>
                      {dispatchedEmail.previewUrl && (
                        <div className="pt-1">
                          <a
                            href={dispatchedEmail.previewUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 underline font-semibold"
                          >
                            <span>Open in Ethereal Webmail</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>

                    {dispatchedEmail.otpCodePreview && (
                      <div className="p-3 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
                            Dispatched 6-Digit OTP
                          </div>
                          <div className="text-lg font-mono font-extrabold tracking-[0.25em] text-white mt-0.5">
                            {dispatchedEmail.otpCodePreview}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleAutoFillFromOutbox(dispatchedEmail.otpCodePreview!)}
                            className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            {copiedOtp ? (
                              <>
                                <Check className="w-3.5 h-3.5" /> Filled!
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" /> Auto-Fill Code
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </form>
        )}

        {/* Footer Quick Actions */}
        <div className="mt-7 pt-4 border-t border-neutral-800 flex items-center justify-between text-xs text-neutral-500">
          <button
            type="button"
            onClick={onOpenSql}
            className="flex items-center gap-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            <FileCode className="w-3.5 h-3.5 text-red-500" />
            <span>Database &amp; Templates</span>
          </button>
          <button
            type="button"
            onClick={onOpenConfig}
            className="flex items-center gap-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            <Database className="w-3.5 h-3.5 text-red-500" />
            <span>Supabase Config</span>
          </button>
        </div>
      </div>

      {/* SMTP Configuration Modal */}
      {isSmtpModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-neutral-900 border border-neutral-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 sm:p-6 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-600/10 border border-red-600/20 flex items-center justify-center text-red-500">
                  <Server className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    Email OTP SMTP Server Configuration
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Connect Gmail, Resend, SendGrid, or custom SMTP for live inbox delivery
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSmtpModalOpen(false)}
                className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSmtp} className="p-5 sm:p-6 space-y-4">
              <div className="p-3 rounded-xl bg-neutral-950 border border-neutral-800 text-xs text-neutral-300 leading-relaxed">
                <strong>How it works:</strong> Enter your SMTP credentials below to send 6-digit OTP emails directly to real email inboxes. For Gmail, use <code className="text-red-400 font-mono">smtp.gmail.com</code> (Port 465) and a 16-character <strong>Google App Password</strong>. Leave password blank to use the built-in Sandbox/Ethereal outbox.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">
                    SMTP Host
                  </label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.gmail.com"
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-sm text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">
                    Port
                  </label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    placeholder="465"
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-sm text-white outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1">
                  SMTP Username / Email
                </label>
                <input
                  type="text"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="your-email@gmail.com"
                  className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-sm text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1">
                  SMTP Password / 16-Digit Google App Password
                </label>
                <input
                  type="password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder="xxxx xxxx xxxx xxxx"
                  className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-sm text-white font-mono outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1">
                  Sender From Address
                </label>
                <input
                  type="text"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  placeholder="MS Fitness Security <no-reply@msfitness.com>"
                  className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-sm text-white outline-none"
                />
              </div>

              {smtpFeedback && (
                <div
                  className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                    smtpFeedback.type === 'success'
                      ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                      : 'bg-red-950/40 border-red-800/60 text-red-300'
                  }`}
                >
                  {smtpFeedback.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <span>{smtpFeedback.text}</span>
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setIsSmtpModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white transition-colors cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={savingSmtp}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-semibold text-white transition-colors flex items-center gap-2 shadow-lg shadow-red-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {savingSmtp && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{savingSmtp ? 'Verifying...' : 'Save & Verify SMTP'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
