import { Resend } from "resend";
import type { PrismaClient } from "@prisma/client";
import type { DigestResult } from "../jobs/dailyDigest.js";

const FROM_ADDRESS = "CyberBrief <digest@cyberbrief.io>";
const DASHBOARD_URL = process.env.FRONTEND_URL || "https://demo.cyberbrief.io";

/**
 * Sends a clean digest notification email — top headlines + CTA to dashboard.
 * Returns true if sent, null if skipped or failed.
 */
export async function sendDigestEmail(
  prisma: PrismaClient,
  userId: string,
  userEmail: string,
  userName: string,
  digestResult: DigestResult
): Promise<true | null> {
  if (!process.env.RESEND_API_KEY) {
    console.error("[EmailService] RESEND_API_KEY is not set, skipping email");
    return null;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Fetch top story groups (critical first) for headlines
    const topGroups = await prisma.newsGroup.findMany({
      where: { userId },
      orderBy: [{ caseType: "asc" }, { date: "desc" }],
      take: 5,
      select: { title: true, caseType: true, synopsis: true },
    });

    // Build headline list
    const headlinesHtml = topGroups
      .map((g) => {
        const icon = g.caseType === 1 ? "&#128308;" : g.caseType === 2 ? "&#128993;" : g.caseType === 3 ? "&#128994;" : "&#9898;";
        const synopsis = g.synopsis ? escapeHtml(g.synopsis.slice(0, 120)) + "..." : "";
        return `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f3f4f6;">
            <span style="font-size:14px;">${icon}</span>
            <strong style="color:#111827;font-size:14px;">${escapeHtml(g.title)}</strong>
            ${synopsis ? `<br/><span style="color:#6b7280;font-size:13px;">${synopsis}</span>` : ""}
          </td>
        </tr>`;
      })
      .join("");

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9fafb;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">

    <!-- Logo / Header -->
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="color:#111827;font-size:20px;margin:0;">CyberBrief</h1>
      <p style="color:#6b7280;font-size:13px;margin:4px 0 0;">Your Intelligence Digest</p>
    </div>

    <!-- Stats Card -->
    <div style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:20px;margin-bottom:20px;">
      <p style="color:#111827;font-size:15px;margin:0 0 12px;">
        Hi ${escapeHtml(userName)}, your latest digest is ready.
      </p>
      <table style="width:100%;text-align:center;margin:12px 0;">
        <tr>
          <td style="padding:8px;">
            <div style="font-size:24px;font-weight:700;color:#111827;">${digestResult.scraped}</div>
            <div style="font-size:12px;color:#6b7280;">Articles Scanned</div>
          </td>
          <td style="padding:8px;">
            <div style="font-size:24px;font-weight:700;color:#2563eb;">${digestResult.matched}</div>
            <div style="font-size:12px;color:#6b7280;">Matched</div>
          </td>
          <td style="padding:8px;">
            <div style="font-size:24px;font-weight:700;color:#059669;">${digestResult.summarized}</div>
            <div style="font-size:12px;color:#6b7280;">Briefings</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Top Headlines -->
    ${topGroups.length > 0 ? `
    <div style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:20px;margin-bottom:20px;">
      <h2 style="color:#111827;font-size:15px;margin:0 0 12px;">Top Headlines</h2>
      <table style="width:100%;border-collapse:collapse;">
        ${headlinesHtml}
      </table>
    </div>
    ` : ""}

    <!-- CTA Button -->
    <div style="text-align:center;margin:24px 0;">
      <a href="${DASHBOARD_URL}/dashboard" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;padding:12px 32px;border-radius:6px;text-decoration:none;">
        View Full Brief
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding-top:16px;border-top:1px solid #e5e7eb;">
      <p style="color:#9ca3af;font-size:11px;margin:0;">
        You received this because you enabled email digests on CyberBrief.<br/>
        <a href="${DASHBOARD_URL}/settings" style="color:#6b7280;text-decoration:underline;">Manage preferences</a>
      </p>
    </div>

  </div>
</body>
</html>`;

    await resend.emails.send({
      from: FROM_ADDRESS,
      to: [userEmail],
      subject: `CyberBrief: ${digestResult.matched} new intelligence items`,
      html,
    });

    // Mark articles as sent
    const unsent = await prisma.userArticle.findMany({
      where: { userId, matched: true, sent: false },
      select: { id: true },
      take: 50,
    });

    if (unsent.length > 0) {
      await prisma.userArticle.updateMany({
        where: { id: { in: unsent.map((u) => u.id) } },
        data: { sent: true, sentAt: new Date() },
      });
    }

    console.log(`[EmailService] Sent digest email to ${userEmail}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EmailService] Failed to send email to ${userEmail}: ${message}`);
    return null;
  }
}

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
