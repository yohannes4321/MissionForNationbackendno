const express = require("express");
const router = express.Router();
const db = require("../db");
const { v4: uuidv4, validate: uuidValidate } = require("uuid");
const { sendMail } = require("../utils/email");
const { authRequired, requireRole } = require("../middleware/auth");
require("dotenv").config();

function buildAcceptInviteUrl(token) {
  const base =
    process.env.INVITE_ACCEPT_URL_BASE ||
    `http://localhost:${process.env.PORT || 4000}`;
  return `${base}/accept-invite?token=${token}`;
}

// Send invitation (super user)
router.post("/send", authRequired, requireRole("super"), async (req, res) => {
  const { email, role, region_id } = req.body;
  console.log("Send invitation request body:", req.body);

  if (!email || !role) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (!region_id) {
    return res.status(400).json({
      error:
        "region_id is required. Create a region via /api/regions as a super user first.",
    });
  }

  if (!uuidValidate(region_id)) {
    return res.status(400).json({ error: "region_id must be a UUID" });
  }

  try {
    const rr = await db.query("SELECT name FROM regions WHERE id=$1", [
      region_id,
    ]);

    if (rr.rowCount !== 1) {
      return res.status(400).json({
        error: "region not found; create it first via /api/regions",
      });
    }

    const regionId = region_id;
    const regionName = rr.rows[0].name;

    const token = uuidv4();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
    const id = uuidv4();

    await db.query(
      `INSERT INTO invitations
      (id, email, role, region_id, token, expires_at, sent_count, accepted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, email, role, regionId, token, expires, 1, false],
    );

    const url = buildAcceptInviteUrl(token);

    try {
      await sendMail({
        to: email,
        subject: "Invitation",
        html: `
          <p>Hello,</p>
          <p>You are invited as <strong>${role}</strong> in region <strong>${regionName}</strong>.</p>
          <p>
            Accept your invitation:
            <a href="${url}">${url}</a>
          </p>
          <p>This invitation expires in 7 days.</p>
        `,
        text: `You are invited as ${role} in region ${regionName}. Accept here: ${url}`,
      });
    } catch (emailErr) {
      console.error("Failed to send email, but invite was created. URL:", url, "Error:", emailErr.message);
      // We still return success but maybe indicate email failed
    }

    return res.json({
      ok: true,
      token,
      region_id: regionId,
      region_name: regionName,
      invitation_url: url
    });
  } catch (err) {
    console.error("Send invitation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Resend invitation
router.post("/resend", authRequired, requireRole("super"), async (req, res) => {
  const { invitation_id } = req.body;

  if (!invitation_id) {
    return res.status(400).json({ error: "Missing invitation_id" });
  }

  if (!uuidValidate(invitation_id)) {
    return res.status(400).json({ error: "invitation_id must be a UUID" });
  }

  try {
    const invr = await db.query("SELECT * FROM invitations WHERE id=$1", [
      invitation_id,
    ]);

    if (invr.rowCount !== 1) {
      return res.status(404).json({ error: "Not found" });
    }

    const inv = invr.rows[0];
    const token = uuidv4();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

    await db.query(
      "UPDATE invitations SET token=$1, expires_at=$2, sent_count=sent_count+1 WHERE id=$3",
      [token, expires, invitation_id],
    );

    const url = buildAcceptInviteUrl(token);

    await sendMail({
      to: inv.email,
      subject: "Invitation (resend)",
      html: `
        <p>Hello,</p>
        <p>Your invitation has been resent.</p>
        <p>
          Accept your invitation:
          <a href="${url}">${url}</a>
        </p>
        <p>This invitation expires in 7 days.</p>
      `,
      text: `Your invitation has been resent. Accept here: ${url}`,
    });

    return res.json({ ok: true, token, invitation_url: url });
  } catch (err) {
    console.error("Resend invitation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Validate invitation token for frontend accept-invite page
router.get("/validate", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: "Missing token" });
  }

  try {
    const invr = await db.query(
      "SELECT id, email, role, region_id, expires_at, accepted FROM invitations WHERE token=$1",
      [token],
    );

    if (invr.rowCount !== 1) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    const inv = invr.rows[0];

    if (inv.accepted) {
      return res.status(400).json({ error: "Invitation already accepted" });
    }

    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: "Invitation expired" });
    }

    let region_name = null;

    if (inv.region_id) {
      const rr = await db.query("SELECT name FROM regions WHERE id=$1", [
        inv.region_id,
      ]);
      if (rr.rowCount === 1) {
        region_name = rr.rows[0].name;
      }
    }

    return res.json({
      ok: true,
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        region_id: inv.region_id,
        region_name,
        expires_at: inv.expires_at,
      },
      token,
    });
  } catch (err) {
    console.error("Validate invitation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
