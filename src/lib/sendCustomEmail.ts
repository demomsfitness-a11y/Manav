import { Member, GymSettings } from '../types';
import { logActivity } from './db';

export interface SendCustomEmailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  senderName?: string;
  senderEmail?: string;
  templateType?: 'welcome' | 'renewal' | 'announcement' | 'diet' | 'custom';
  memberName?: string;
  memberId?: string;
  adminEmail: string;
  gymSettings?: GymSettings;
}

export interface SendCustomEmailResult {
  success: boolean;
  message: string;
  deliveryMode?: 'smtp' | 'ethereal' | 'sandbox';
  previewUrl?: string | null;
  messageId?: string;
  from?: string;
  error?: string;
}

export async function sendCustomEmail(
  options: SendCustomEmailOptions
): Promise<SendCustomEmailResult> {
  const {
    to,
    subject,
    html,
    text,
    senderName = 'MS Fitness',
    senderEmail = 'singhalmanav58@gmail.com',
    templateType = 'custom',
    memberName,
    memberId,
    adminEmail,
    gymSettings,
  } = options;

  const cleanTo = (to || '').trim().toLowerCase();
  if (!cleanTo || !cleanTo.includes('@')) {
    const errorMsg = 'Please enter a valid recipient email address.';
    return {
      success: false,
      message: errorMsg,
      error: errorMsg,
    };
  }

  if (!subject.trim()) {
    const errorMsg = 'Email subject is required.';
    return {
      success: false,
      message: errorMsg,
      error: errorMsg,
    };
  }

  try {
    const response = await fetch('/api/send-custom-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: cleanTo,
        subject: subject.trim(),
        html,
        text,
        senderName,
        senderEmail: senderEmail.trim().toLowerCase(),
        templateType,
        memberName,
        memberId,
        gymSettings,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      const err = data.error || 'Server failed to deliver email';
      await logActivity(
        'EMAIL_DISPATCH_FAILED',
        `Failed to send email to ${cleanTo} from ${senderEmail}: ${err}`,
        adminEmail
      );
      return {
        success: false,
        message: err,
        error: err,
      };
    }

    await logActivity(
      'CUSTOM_EMAIL_SENT',
      `Sent email to ${cleanTo} from ${senderEmail} ("${subject.trim()}")`,
      adminEmail
    );

    return {
      success: true,
      message: data.message || `Email sent successfully to ${cleanTo} from ${senderEmail}.`,
      deliveryMode: data.deliveryMode,
      previewUrl: data.previewUrl,
      messageId: data.messageId,
      from: data.from || senderEmail,
    };
  } catch (err: any) {
    const errText = err.message || 'Network error sending custom email';
    await logActivity(
      'EMAIL_DISPATCH_FAILED',
      `Failed to send email to ${cleanTo} from ${senderEmail}: ${errText}`,
      adminEmail
    );
    return {
      success: false,
      message: errText,
      error: errText,
    };
  }
}
