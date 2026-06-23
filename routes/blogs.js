const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

function parseExpiryDate(expiresInDays) {
  if (expiresInDays === undefined || expiresInDays === null || expiresInDays === '') return null;
  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Create blog item for homepage (super only)
router.post('/', authRequired, requireRole('super'), async (req, res) => {
  try {
    const { text, image_url: imageUrl, video_url: videoUrl, expires_in_days } = req.body;

    if (!imageUrl && !videoUrl) {
      return res.status(400).json({ error: 'Provide at least one media URL: image_url or video_url' });
    }

    const expiresAt = parseExpiryDate(expires_in_days);
    if (expiresAt === undefined) {
      return res.status(400).json({ error: 'expires_in_days must be a positive number' });
    }

    const id = uuidv4();
    await db.query(
      'INSERT INTO blogs(id,author_id,text,image_url,video_url,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,NOW())',
      [id, req.user.id, text || '', imageUrl || null, videoUrl || null, expiresAt]
    );

    return res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Fetch homepage blogs
router.get('/', async (req, res) => {
  try {
    const { search = '', sort = 'newest', include_expired = 'false' } = req.query;
    const isNewest = sort !== 'oldest';
    const includeExpired = String(include_expired).toLowerCase() === 'true';

    const result = await db.query(
      `
        SELECT id, text, image_url, video_url, created_at, expires_at
        FROM blogs
        WHERE ($1 = '' OR text ILIKE '%' || $1 || '%')
          AND ($2::boolean = true OR expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at ${isNewest ? 'DESC' : 'ASC'}
      `,
      [search, includeExpired]
    );

    return res.json({ blogs: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Update blog item (super only)
router.put('/:id', authRequired, requireRole('super'), async (req, res) => {
  try {
    const { id } = req.params;
    const { text, image_url, video_url, expires_in_days } = req.body;

    const existing = await db.query('SELECT * FROM blogs WHERE id=$1', [id]);
    if (existing.rowCount !== 1) return res.status(404).json({ error: 'Blog not found' });

    const expiresAt = expires_in_days !== undefined
      ? parseExpiryDate(expires_in_days)
      : existing.rows[0].expires_at;

    if (expires_in_days !== undefined && expiresAt === undefined) {
      return res.status(400).json({ error: 'expires_in_days must be a positive number' });
    }

    await db.query(
      `UPDATE blogs
       SET text = $1, image_url = $2, video_url = $3, expires_at = $4
       WHERE id = $5`,
      [
        text !== undefined ? text : existing.rows[0].text,
        image_url !== undefined ? image_url : existing.rows[0].image_url,
        video_url !== undefined ? video_url : existing.rows[0].video_url,
        expiresAt,
        id
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete blog item (super only)
router.delete('/:id', authRequired, requireRole('super'), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.query('SELECT * FROM blogs WHERE id=$1', [id]);
    if (existing.rowCount !== 1) return res.status(404).json({ error: 'Blog not found' });

    await db.query('DELETE FROM blogs WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
