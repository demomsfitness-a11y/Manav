import React, { useState, useEffect } from 'react';
import { Member, GymSettings } from '../types';
import { sendCustomEmail, SendCustomEmailResult } from '../lib/sendCustomEmail';
import {
  Mail,
  X,
  Send,
  User,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Eye,
  FileText,
  Clock,
  ShieldCheck,
  Check,
} from 'lucide-react';

export type TemplateKey = 'custom' | 'welcome' | 'renewal' | 'announcement' | 'diet';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  members: Member[];
  initialRecipientEmail?: string;
  initialMember?: Member;
  initialTemplateType?: TemplateKey;
  adminEmail: string;
  gymSettings?: GymSettings;
}

export const SendEmailModal: React.FC<Props> = ({
  isOpen,
  onClose,
  members,
  initialRecipientEmail = '',
  initialMember,
  initialTemplateType = 'custom',
  adminEmail,
  gymSettings,
}) => {
  const [selectedMemberId, setSelectedMemberId] = useState<string>(initialMember?.id || '');
  const [recipientEmail, setRecipientEmail] = useState<string>(
    initialRecipientEmail || initialMember?.email || ''
  );
  const [recipientName, setRecipientName] = useState<string>(initialMember?.name || '');
  const [subject, setSubject] = useState<string>('');
  const [bodyText, setBodyText] = useState<string>('');
  const [activeTemplate, setActiveTemplate] = useState<TemplateKey>(initialTemplateType);
  const [activeTab, setActiveTab] = useState<'compose' | 'preview'>('compose');

  const [isSending, setIsSending] = useState<boolean>(false);
  const [sendResult, setSendResult] = useState<SendCustomEmailResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const senderEmail = 'singhalmanav58@gmail.com';
  const gymName = gymSettings?.gym_name || 'MS Fitness';

  // Apply template content
  const applyTemplate = (key: TemplateKey, name: string, member?: Member) => {
    setActiveTemplate(key);
    setErrorMsg(null);
    setSendResult(null);

    const athleteName = name || 'Valued Athlete';
    const expiryDate = member?.membership_expiry
      ? new Date(member.membership_expiry).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : 'upcoming date';

    switch (key) {
      case 'welcome':
        setSubject(`Welcome to ${gymName}, ${athleteName}! Let's Crush Your Fitness Goals 💪`);
        setBodyText(
          `We are absolutely thrilled to welcome you to the ${gymName} family!\n\n` +
            `Your membership is now active and your athlete profile is registered.\n\n` +
            `• Operating Hours: 6:00 AM – 10:00 PM (Monday to Saturday)\n` +
            `• Facility Rules: Please carry clean indoor gym shoes and a workout towel.\n` +
            `• Certified Trainers: Our floor trainers are always available to help you with equipment setup and posture corrections.\n\n` +
            `If you have any questions or need a personalized workout assessment, reply directly to this email.\n\n` +
            `Stay strong and see you on the gym floor!`
        );
        break;

      case 'renewal':
        setSubject(`${gymName} Membership Renewal Reminder - ${athleteName}`);
        setBodyText(
          `This is a friendly reminder that your gym membership is scheduled for renewal on ${expiryDate}.\n\n` +
            `To maintain uninterrupted access to all fitness zones, locker facilities, and training sessions, please renew your membership before the expiry date.\n\n` +
            `• Quick UPI Renewal: ${gymSettings?.upi_id || 'msfitness@upi'}\n` +
            `• Front Desk: Cash, UPI, and Card accepted.\n\n` +
            `Keep pushing your boundaries and don't break the streak!`
        );
        break;

      case 'announcement':
        setSubject(`Important Update from ${gymName} Management`);
        setBodyText(
          `We have an important announcement for all ${gymName} athletes.\n\n` +
            `We are continuously upgrading our fitness equipment and training spaces to provide you with the best gym experience.\n\n` +
            `Please feel free to reach out to us at ${senderEmail} with any suggestions or feedback.\n\n` +
            `Thank you for being a committed member of our community!`
        );
        break;

      case 'diet':
        setSubject(`${gymName} Nutrition & Recovery Guide for ${athleteName}`);
        setBodyText(
          `Consistency in nutrition is just as crucial as the hours you invest on the gym floor.\n\n` +
            `Key Recovery Tips:\n` +
            `1. Protein intake: Consume 20-30g of high-quality protein within 45 minutes post-workout.\n` +
            `2. Hydration: Drink at least 3-4 liters of water daily to maintain muscle recovery.\n` +
            `3. Sleep: Aim for 7-8 hours of quality sleep to maximize muscle protein synthesis.\n\n` +
            `Feel free to consult our certified gym trainers for customized diet advice!`
        );
        break;

      case 'custom':
      default:
        setSubject(`Message from ${gymName}`);
        setBodyText(
          `Hello ${athleteName},\n\n` +
            `We are reaching out regarding your membership at ${gymName}.\n\n` +
            `Please let us know if you need any assistance.`
        );
        break;
    }
  };

  // Sync state when modal opens or initial props change
  useEffect(() => {
    if (isOpen) {
      const initialName = initialMember?.name || '';
      setSelectedMemberId(initialMember?.id || '');
      setRecipientEmail(initialRecipientEmail || initialMember?.email || '');
      setRecipientName(initialName);
      setSendResult(null);
      setErrorMsg(null);
      setActiveTab('compose');
      applyTemplate((initialTemplateType as TemplateKey) || 'custom', initialName, initialMember);
    }
  }, [isOpen, initialMember, initialRecipientEmail, initialTemplateType]);

  if (!isOpen) return null;

  // Handle member selection change
  const handleSelectMember = (memberId: string) => {
    setSelectedMemberId(memberId);
    if (!memberId) return;

    const found = members.find((m) => m.id === memberId);
    if (found) {
      setRecipientEmail(found.email || '');
      setRecipientName(found.name);
      applyTemplate(activeTemplate, found.name, found);
    }
  };

  // Handle Send action
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanTo = recipientEmail.trim().toLowerCase();
    if (!cleanTo || !cleanTo.includes('@')) {
      setErrorMsg('Please enter a valid recipient email address.');
      return;
    }

    if (!subject.trim()) {
      setErrorMsg('Please enter an email subject.');
      return;
    }

    if (!bodyText.trim()) {
      setErrorMsg('Please enter email body content.');
      return;
    }

    setIsSending(true);

    try {
      const res = await sendCustomEmail({
        to: cleanTo,
        subject: subject.trim(),
        text: bodyText.trim(),
        senderName: gymName,
        senderEmail,
        templateType: activeTemplate,
        memberName: recipientName,
        adminEmail,
        gymSettings,
      });

      if (res.success) {
        setSendResult(res);
      } else {
        setErrorMsg(res.error || res.message || 'Failed to dispatch email.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'An error occurred while sending email.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 overflow-y-auto">
      <div className="bg-neutral-900 border border-neutral-800 rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="p-5 sm:p-6 border-b border-neutral-800 bg-neutral-950/70 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-red-600/15 border border-red-500/30 text-red-500 flex items-center justify-center shadow-lg shadow-red-600/10">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white tracking-wide">
                  Send Email with {senderEmail}
                </h2>
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                Official outbound communication dispatched from verified Super Admin address
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:text-white rounded-xl hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sender Info Banner */}
        <div className="px-6 py-2.5 bg-neutral-950 border-b border-neutral-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 font-medium">From:</span>
            <span className="font-semibold text-white bg-neutral-900 px-2.5 py-1 rounded-lg border border-neutral-800 font-mono flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              {senderEmail}
            </span>
            <span className="text-neutral-400 hidden sm:inline">• MS Fitness Management</span>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Active Outbound Service</span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 space-y-4 overflow-y-auto">
          {/* Success Screen */}
          {sendResult ? (
            <div className="p-6 rounded-2xl bg-emerald-950/40 border border-emerald-800/60 text-center space-y-4 animate-in fade-in duration-200">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Email Sent Successfully!</h3>
                <p className="text-xs text-emerald-300 mt-1">{sendResult.message}</p>
                <p className="text-[11px] text-neutral-400 mt-1 font-mono">
                  Sender: <strong className="text-white">{senderEmail}</strong> &rarr; Recipient:{' '}
                  <strong className="text-white">{recipientEmail}</strong>
                </p>
              </div>

              {sendResult.previewUrl && (
                <div className="pt-2">
                  <a
                    href={sendResult.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs font-semibold transition-colors"
                  >
                    <span>View Dispatched Email in Ethereal Webmail</span>
                    <ExternalLink className="w-3.5 h-3.5 text-red-400" />
                  </a>
                </div>
              )}

              <div className="pt-3 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setSendResult(null);
                    setSubject(`Message from ${gymName}`);
                    setBodyText('');
                  }}
                  className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                >
                  Send Another Email
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSend} className="space-y-4">
              {errorMsg && (
                <div className="p-3.5 rounded-2xl bg-red-950/60 border border-red-800/70 text-red-200 text-xs flex items-center gap-2.5">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Recipient Picker */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-red-500" /> Choose Registered Member
                  </label>
                  <select
                    value={selectedMemberId}
                    onChange={(e) => handleSelectMember(e.target.value)}
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-xs text-white outline-none"
                  >
                    <option value="">-- Or enter custom recipient below --</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.member_id}) {m.email ? `• ${m.email}` : '• No email'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-red-500" /> Recipient Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    value={recipientEmail}
                    onChange={(e) => {
                      setRecipientEmail(e.target.value);
                      if (errorMsg) setErrorMsg(null);
                    }}
                    placeholder="athlete@example.com"
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2 text-xs text-white placeholder-neutral-600 outline-none"
                  />
                </div>
              </div>

              {/* Template Picker Tabs */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-red-500" /> Quick Email Template
                </label>
                <div className="flex flex-wrap items-center gap-1.5 p-1 bg-neutral-950 border border-neutral-800 rounded-xl text-xs">
                  <button
                    type="button"
                    onClick={() => applyTemplate('welcome', recipientName)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                      activeTemplate === 'welcome'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Welcome
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('renewal', recipientName)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                      activeTemplate === 'renewal'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Renewal Reminder
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('diet', recipientName)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                      activeTemplate === 'diet'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Nutrition &amp; Diet
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('announcement', recipientName)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                      activeTemplate === 'announcement'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Announcement
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('custom', recipientName)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                      activeTemplate === 'custom'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Custom
                  </button>
                </div>
              </div>

              {/* Subject */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1">
                  Email Subject *
                </label>
                <input
                  type="text"
                  required
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Welcome to MS Fitness!"
                  className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-600 outline-none"
                />
              </div>

              {/* Body editor / Preview tabs */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-red-500" /> Email Message Content *
                  </label>
                  <div className="flex items-center gap-1 bg-neutral-950 p-0.5 rounded-lg border border-neutral-800 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setActiveTab('compose')}
                      className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                        activeTab === 'compose' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      Compose
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('preview')}
                      className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                        activeTab === 'preview' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      HTML Preview
                    </button>
                  </div>
                </div>

                {activeTab === 'compose' ? (
                  <textarea
                    rows={6}
                    required
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    placeholder="Type your message here..."
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-red-500 rounded-xl p-3 text-xs text-white leading-relaxed placeholder-neutral-600 outline-none resize-none font-sans"
                  />
                ) : (
                  <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-xs space-y-3 max-h-56 overflow-y-auto">
                    <div className="border-b border-neutral-800 pb-2 flex items-center justify-between text-neutral-400 text-[11px]">
                      <span>
                        From: <strong className="text-white">{senderEmail}</strong>
                      </span>
                      <span>
                        To: <strong className="text-white">{recipientEmail || 'athlete@example.com'}</strong>
                      </span>
                    </div>
                    <div className="font-bold text-white text-sm">{subject || '(No Subject)'}</div>
                    <div className="text-neutral-300 whitespace-pre-line leading-relaxed">
                      {bodyText || '(No message content)'}
                    </div>
                    <div className="pt-2 border-t border-neutral-800 text-[11px] text-neutral-500">
                      Best regards,
                      <br />
                      <strong className="text-neutral-300">{gymName} Management</strong>
                      <br />
                      {senderEmail}
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-neutral-800 flex items-center justify-between">
                <div className="text-[11px] text-neutral-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Sender verified: {senderEmail}</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSending}
                    className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs transition-all shadow-lg shadow-red-600/25 flex items-center gap-2 disabled:opacity-50 cursor-pointer"
                  >
                    {isSending ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Sending from {senderEmail}...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Send Email</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
