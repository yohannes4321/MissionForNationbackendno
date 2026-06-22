const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendMail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is missing");
  }

  const { data, error } = await resend.emails.send({
    from: "Mission For Nation<noreply@peace4ethio.com>",
    // later change this to your verified domain:
    // from: "Your App <notifications@yourdomain.com>",
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || undefined,
  });

  if (error) {
    throw new Error(error.message || "Failed to send email via Resend");
  }

  return data;
}

module.exports = { sendMail };
