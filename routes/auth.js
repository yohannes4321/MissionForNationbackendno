const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { sendMail } = require("../utils/email");
require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET || "secret";

async function getValidInvitation(token, email) {
  const inv = await db.query(
    "SELECT * FROM invitations WHERE token=$1 AND accepted=false",
    [token],
  );
  if (inv.rowCount !== 1)
    return { ok: false, error: "Invalid invitation token" };
  const invitation = inv.rows[0];
  if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
    return { ok: false, error: "Invitation expired" };
  }
  if (email && invitation.email.toLowerCase() !== email.toLowerCase()) {
    return { ok: false, error: "Invitation email mismatch" };
  }
  return { ok: true, invitation };
}

router.post("/register", async (req, res) => {
  const { email, password, token } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const hashed = await bcrypt.hash(password, 10);
    // If token provided, link to invitation
    let role = "user";
    let region_id = null;
    if (token) {
      const invResult = await getValidInvitation(token, email);
      if (!invResult.ok)
        return res.status(400).json({ error: invResult.error });
      role = invResult.invitation.role;
      region_id = invResult.invitation.region_id;
      await db.query("UPDATE invitations SET accepted=true WHERE id=$1", [
        invResult.invitation.id,
      ]);
    }
    const id = uuidv4();
    await db.query(
      "INSERT INTO users(id,email,password,role) VALUES($1,$2,$3,$4)",
      [id, email, hashed, role],
    );
    if (region_id) {
      await db.query(
        "INSERT INTO user_regions(user_id, region_id) VALUES($1,$2)",
        [id, region_id],
      );
    }
    const authToken = jwt.sign({ id, email, role }, JWT_SECRET, {
      expiresIn: "7d",
    });
    return res.json({
      ok: true,
      token: authToken,
      user: { id, email, role, region_id },
    });
  } catch (err) {
    console.error(err);
    if (err.code === "23505")
      return res.status(409).json({ error: "Email already exists" });
    return res.status(500).json({ error: "Server error" });
  }
});

// Accept invitation and sign in directly
router.post("/accept-invite", async (req, res) => {
  const { token, email, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ error: "Missing token or password" });
  try {
    const invResult = await getValidInvitation(token, email);
    if (!invResult.ok) return res.status(400).json({ error: invResult.error });

    const invitationEmail = invResult.invitation.email;

    const existing = await db.query("SELECT id FROM users WHERE email=$1", [
      invitationEmail,
    ]);
    let id;
    if (existing.rowCount > 0) {
      // User already exists, mark invitation as accepted and return success
      await db.query("UPDATE invitations SET accepted=true WHERE id=$1", [
        invResult.invitation.id,
      ]);
      id = existing.rows[0].id;
      const role = invResult.invitation.role;
      const region_id = invResult.invitation.region_id;
      const authToken = jwt.sign(
        { id, email: invitationEmail, role },
        JWT_SECRET,
        { expiresIn: "7d" },
      );
      return res.json({
        ok: true,
        token: authToken,
        user: { id, email: invitationEmail, role, region_id },
        message: "Invitation accepted. User already exists."
      });
    }

    const hashed = await bcrypt.hash(password, 10);
    id = uuidv4();
    const role = invResult.invitation.role;
    const region_id = invResult.invitation.region_id;

    await db.query(
      "INSERT INTO users(id,email,password,role) VALUES($1,$2,$3,$4)",
      [id, invitationEmail, hashed, role],
    );
    if (region_id) {
      await db.query(
        "INSERT INTO user_regions(user_id, region_id) VALUES($1,$2)",
        [id, region_id],
      );
    }
    await db.query("UPDATE invitations SET accepted=true WHERE id=$1", [
      invResult.invitation.id,
    ]);

    const authToken = jwt.sign(
      { id, email: invitationEmail, role },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    return res.json({
      ok: true,
      token: authToken,
      user: { id, email: invitationEmail, role, region_id },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const user = await db.query(
      "SELECT id,email,password,role FROM users WHERE email=$1",
      [email],
    );
    if (user.rowCount !== 1)
      return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.rows[0].password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const { id, email: userEmail, role } = user.rows[0];
    const authToken = jwt.sign({ id, email: userEmail, role }, JWT_SECRET, {
      expiresIn: "7d",
    });
    return res.json({
      ok: true,
      token: authToken,
      user: { id, email: userEmail, role },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/accept-invite", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing token");

  try {
    const invResult = await getValidInvitation(token);
    if (!invResult.ok) return res.status(400).send(invResult.error);

    const invitationEmail = invResult.invitation.email;

    return res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Accept Invitation</title>
    <style>
      body { font-family: sans-serif; max-width: 420px; margin: 48px auto; padding: 0 16px; }
      input, button { width: 100%; padding: 10px; margin-top: 10px; }
      .muted { color: #444; font-size: 14px; }
      .error { color: #b00020; margin-top: 10px; }
      .ok { color: #066a2f; margin-top: 10px; }
    </style>
  </head>
  <body>
    <h2>Accept Invitation</h2>
    <p class="muted">Email: ${invitationEmail}</p>
    <form id="accept-form">
      <input id="password" type="password" placeholder="Set your password" required minlength="8" />
      <button type="submit">Create Account</button>
    </form>
    <div id="message"></div>
    <script>
      const form = document.getElementById('accept-form');
      const message = document.getElementById('message');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        message.className = '';
        message.textContent = 'Creating account...';

        const password = document.getElementById('password').value;
        const response = await fetch('/auth/accept-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', password })
        });

        const data = await response.json();
        if (!response.ok) {
          message.className = 'error';
          message.textContent = data.error || 'Failed to accept invitation';
          return;
        }

        message.className = 'ok';
        message.textContent = 'Account created. You can now log in.';
      });
    </script>
  </body>
</html>`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const user = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    if (user.rowCount !== 1)
      return res.status(401).json({ error: "Invalid credentials" });
    const u = user.rows[0];
    if (!u.password)
      return res
        .status(400)
        .json({ error: "No password set; accept invitation first" });
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign(
      { id: u.id, email: u.email, role: u.role },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    return res.json({
      token,
      user: { id: u.id, email: u.email, role: u.role },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });
  try {
    const user = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    if (user.rowCount !== 1) return res.json({ ok: true });
    const token = uuidv4();
    const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
    await db.query(
      "INSERT INTO password_resets(id,user_id,token,expires_at) VALUES($1,$2,$3,$4)",
      [uuidv4(), user.rows[0].id, token, expires],
    );
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`;
    await sendMail({
      to: email,
      subject: "Reset password",
      html: `<p>Reset: <a href="${url}">${url}</a></p>`,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const row = await db.query("SELECT * FROM password_resets WHERE token=$1", [
      token,
    ]);
    if (row.rowCount !== 1)
      return res.status(400).json({ error: "Invalid token" });
    const pr = row.rows[0];
    if (new Date(pr.expires_at) < new Date())
      return res.status(400).json({ error: "Expired" });
    const hashed = await bcrypt.hash(password, 10);
    await db.query("UPDATE users SET password=$1 WHERE id=$2", [
      hashed,
      pr.user_id,
    ]);
    await db.query("DELETE FROM password_resets WHERE id=$1", [pr.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
