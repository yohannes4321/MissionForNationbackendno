const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const { authRequired, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { uploadBufferToCloudinary } = require('../utils/cloudinary');

const ALLOWED_CATEGORIES = ['special_program', 'mission', 'program_sunday'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

const anyUploadField = upload.any();

function runMulter(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Max size is 200MB' });
        }
        return res.status(400).json({ error: err.message });
      }
      return next(err);
    });
  };
}

function requireCloudinaryConfig(req, res, next) {
  const hasConfig =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;

  if (!hasConfig) {
    return res.status(500).json({ error: 'Cloudinary is not configured on server' });
  }

  return next();
}

function getUploadedMediaFiles(req) {
  const files = Array.isArray(req.files) ? req.files : [];
  let imageFile = null;
  let videoFile = null;

  for (const file of files) {
    if (!imageFile && file.mimetype && file.mimetype.startsWith('image/')) imageFile = file;
    if (!videoFile && file.mimetype && file.mimetype.startsWith('video/')) videoFile = file;
  }

  return { imageFile, videoFile };
}

function parseExpiryDate(expiresInDays) {
  if (expiresInDays === undefined || expiresInDays === null || expiresInDays === '') return null;
  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function userCanPostToRegion(userId, regionId) {
  const membership = await db.query('SELECT 1 FROM user_regions WHERE user_id=$1 AND region_id=$2', [userId, regionId]);
  return membership.rowCount > 0;
}

async function validateChurchIdsForRegion(churchIds, regionId) {
  if (!Array.isArray(churchIds) || churchIds.length === 0) return true;
  const uniqueChurchIds = [...new Set(churchIds)];
  const c = await db.query('SELECT id FROM churches WHERE region_id=$1 AND id = ANY($2::uuid[])', [regionId, uniqueChurchIds]);
  return c.rowCount === uniqueChurchIds.length;
}

async function getChurchById(churchId) {
  const result = await db.query('SELECT * FROM churches WHERE id=$1', [churchId]);
  return result.rowCount === 1 ? result.rows[0] : null;
}

function normalizeJsonArray(value, fieldName) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value;
}

function normalizeJsonObject(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${fieldName} must be an object`);
  return value;
}

// List users (super)
router.get('/users', authRequired, requireRole('super'), async (req, res) => {
  const result = await db.query('SELECT id,email,role FROM users');
  return res.json({ users: result.rows });
});

// Change role (super)
router.post('/change-role', authRequired, requireRole('super'), async (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id || !role) return res.status(400).json({ error: 'Missing' });
  await db.query('UPDATE users SET role=$1 WHERE id=$2', [role, user_id]);
  return res.json({ ok: true });
});

// Create region (super)
router.post('/regions', authRequired, requireRole('super'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = uuidv4();
  await db.query('INSERT INTO regions(id,name) VALUES($1,$2)', [id, name]);
  return res.json({ ok: true, id });
});

// Public list of regions
router.get('/regions', async (req, res) => {
  const r = await db.query('SELECT * FROM regions');
  return res.json({ regions: r.rows });
});

// Add church to a region (super or regional_admin)
router.post('/churches', authRequired, requireRole('super', 'regional_admin'), async (req, res) => {
  try {
    const {
      id: external_id,
      name,
      location,
      address,
      phone,
      email,
      description,
      heroImage,
      serviceTimes,
      announcements,
      pastor,
      events,
      ministries,
      gallery,
      mapUrl,
      region_id,
      regionId,
      location_link
    } = req.body;

    const resolvedRegionId = region_id || regionId;
    if (!name || !resolvedRegionId) return res.status(400).json({ error: 'Missing name or region_id' });

    const rr = await db.query('SELECT id FROM regions WHERE id=$1', [resolvedRegionId]);
  if (rr.rowCount !== 1) return res.status(400).json({ error: 'Region not found' });

    if (req.user.role === 'regional_admin') {
      const allowedRegion = await userCanPostToRegion(req.user.id, resolvedRegionId);
      if (!allowedRegion) return res.status(403).json({ error: 'Forbidden for this region' });
    }

    const normalizedServiceTimes = normalizeJsonArray(serviceTimes, 'serviceTimes');
    const normalizedAnnouncements = normalizeJsonArray(announcements, 'announcements');
    const normalizedEvents = normalizeJsonArray(events, 'events');
    const normalizedMinistries = normalizeJsonArray(ministries, 'ministries');
    const normalizedGallery = normalizeJsonArray(gallery, 'gallery');
    const normalizedPastor = normalizeJsonObject(pastor, 'pastor');

    const churchId = uuidv4();
    await db.query(
      `INSERT INTO churches(
        id,external_id,name,region_id,location,address,phone,email,description,hero_image,
        service_times,announcements,pastor,events,ministries,gallery,map_url,location_link,created_at,updated_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,NOW(),NOW()
      )`,
      [
        churchId,
        external_id || null,
        name,
        resolvedRegionId,
        location || null,
        address || null,
        phone || null,
        email || null,
        description || null,
        heroImage || null,
        JSON.stringify(normalizedServiceTimes),
        JSON.stringify(normalizedAnnouncements),
        JSON.stringify(normalizedPastor),
        JSON.stringify(normalizedEvents),
        JSON.stringify(normalizedMinistries),
        JSON.stringify(normalizedGallery),
        mapUrl || null,
        location_link || null
      ]
    );

    return res.json({ ok: true, id: churchId, external_id: external_id || null });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Church id already exists for this region' });
    }
    if (err.message && err.message.includes('must be')) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Public list of churches (optionally filtered by region_id)
router.get('/churches', async (req, res) => {
  const { region_id } = req.query;

  if (region_id) {
    const c = await db.query('SELECT * FROM churches WHERE region_id=$1 ORDER BY created_at DESC', [region_id]);
    return res.json({ churches: c.rows });
  }

  const c = await db.query('SELECT * FROM churches ORDER BY created_at DESC');
  return res.json({ churches: c.rows });
});

// Public church detail by id
router.get('/churches/:id', async (req, res) => {
  const { id } = req.params;
  const c = await db.query('SELECT * FROM churches WHERE id=$1', [id]);
  if (c.rowCount !== 1) return res.status(404).json({ error: 'Church not found' });
  return res.json({ church: c.rows[0] });
});

// Update church details by church UUID (super or owning regional_admin)
router.put('/churches/:id', authRequired, requireRole('super', 'regional_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await getChurchById(id);
    if (!existing) return res.status(404).json({ error: 'Church not found' });

    if (req.user.role === 'regional_admin') {
      const allowedRegion = await userCanPostToRegion(req.user.id, existing.region_id);
      if (!allowedRegion) return res.status(403).json({ error: 'Forbidden for this region' });
    }

    const {
      id: external_id,
      name,
      location,
      address,
      phone,
      email,
      description,
      heroImage,
      serviceTimes,
      announcements,
      pastor,
      events,
      ministries,
      gallery,
      mapUrl,
      location_link
    } = req.body;

    const normalizedServiceTimes =
      serviceTimes === undefined ? existing.service_times : normalizeJsonArray(serviceTimes, 'serviceTimes');
    const normalizedAnnouncements =
      announcements === undefined ? existing.announcements : normalizeJsonArray(announcements, 'announcements');
    const normalizedEvents = events === undefined ? existing.events : normalizeJsonArray(events, 'events');
    const normalizedMinistries =
      ministries === undefined ? existing.ministries : normalizeJsonArray(ministries, 'ministries');
    const normalizedGallery = gallery === undefined ? existing.gallery : normalizeJsonArray(gallery, 'gallery');
    const normalizedPastor = pastor === undefined ? existing.pastor : normalizeJsonObject(pastor, 'pastor');

    await db.query(
      `UPDATE churches
       SET external_id = $1,
           name = $2,
           location = $3,
           address = $4,
           phone = $5,
           email = $6,
           description = $7,
           hero_image = $8,
           service_times = $9::jsonb,
           announcements = $10::jsonb,
           pastor = $11::jsonb,
           events = $12::jsonb,
           ministries = $13::jsonb,
           gallery = $14::jsonb,
           map_url = $15,
           location_link = $16,
           updated_at = NOW()
       WHERE id = $17`,
      [
        external_id === undefined ? existing.external_id : external_id,
        name === undefined ? existing.name : name,
        location === undefined ? existing.location : location,
        address === undefined ? existing.address : address,
        phone === undefined ? existing.phone : phone,
        email === undefined ? existing.email : email,
        description === undefined ? existing.description : description,
        heroImage === undefined ? existing.hero_image : heroImage,
        JSON.stringify(normalizedServiceTimes),
        JSON.stringify(normalizedAnnouncements),
        JSON.stringify(normalizedPastor),
        JSON.stringify(normalizedEvents),
        JSON.stringify(normalizedMinistries),
        JSON.stringify(normalizedGallery),
        mapUrl === undefined ? existing.map_url : mapUrl,
        location_link === undefined ? existing.location_link : location_link,
        id
      ]
    );

    const updated = await getChurchById(id);
    return res.json({ ok: true, church: updated });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Church id already exists for this region' });
    if (err.message && err.message.includes('must be')) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete church by church UUID (super or owning regional_admin)
router.delete('/churches/:id', authRequired, requireRole('super', 'regional_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await getChurchById(id);
    if (!existing) return res.status(404).json({ error: 'Church not found' });

    if (req.user.role === 'regional_admin') {
      const allowedRegion = await userCanPostToRegion(req.user.id, existing.region_id);
      if (!allowedRegion) return res.status(403).json({ error: 'Forbidden for this region' });
    }

    await db.query('DELETE FROM churches WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Create post (super or regional admin)
router.post('/posts', authRequired, async (req, res) => {
  const {
    title,
    type,
    content,
    region_id,
    category,
    image_url,
    video_url,
    location_link,
    church_ids,
    expires_in_days
  } = req.body;

  if (!content || !region_id) return res.status(400).json({ error: 'Missing content or region_id' });
  if (!category || !ALLOWED_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}` });
  }

  const expiresAt = parseExpiryDate(expires_in_days);
  if (expiresAt === undefined) return res.status(400).json({ error: 'expires_in_days must be a positive number' });

  const user = req.user;
  // super can post to anywhere; regional can only post to their region
  if (user.role === 'regional_admin') {
    const allowedRegion = await userCanPostToRegion(user.id, region_id);
    if (!allowedRegion) return res.status(403).json({ error: 'Forbidden for this region' });
  } else if (user.role !== 'super') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const validChurches = await validateChurchIdsForRegion(church_ids, region_id);
  if (!validChurches) return res.status(400).json({ error: 'One or more church_ids do not belong to the selected region' });

  const id = uuidv4();
  await db.query(
    `INSERT INTO posts(
      id,author_id,region_id,title,type,content,category,image_url,video_url,location_link,expires_at,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
    [
      id,
      user.id,
      region_id,
      title || null,
      type || null,
      content,
      category,
      image_url || null,
      video_url || null,
      location_link || null,
      expiresAt
    ]
  );

  if (Array.isArray(church_ids) && church_ids.length > 0) {
    const uniqueChurchIds = [...new Set(church_ids)];
    for (const churchId of uniqueChurchIds) {
      await db.query('INSERT INTO post_churches(post_id,church_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, churchId]);
    }
  }

  return res.json({ ok: true, id });
});

// Public list posts for region (search + sort + newest first + timestamps)
router.get('/posts', async (req, res) => {
  const { region_id, search = '', sort = 'newest', include_expired = 'false', category } = req.query;
  if (!region_id) return res.status(400).json({ error: 'Missing region_id' });

  const includeExpired = String(include_expired).toLowerCase() === 'true';
  const isNewest = sort !== 'oldest';
  const normalizedCategory = category || '';

  const r = await db.query(
    `SELECT
      p.id,
      p.author_id,
      p.region_id,
      p.title,
      p.type,
      p.content,
      p.category,
      p.image_url,
      p.video_url,
      p.location_link,
      p.expires_at,
      p.created_at,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', c.id,
            'name', c.name,
            'region_id', c.region_id,
            'location_link', c.location_link
          )
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'::json
      ) AS churches
    FROM posts p
    LEFT JOIN post_churches pc ON pc.post_id = p.id
    LEFT JOIN churches c ON c.id = pc.church_id
    WHERE p.region_id = $1
      AND ($2 = '' OR p.content ILIKE '%' || $2 || '%' OR p.title ILIKE '%' || $2 || '%')
      AND ($3 = '' OR p.category = $3)
      AND ($4::boolean = true OR p.expires_at IS NULL OR p.expires_at > NOW())
    GROUP BY p.id
    ORDER BY p.created_at ${isNewest ? 'DESC' : 'ASC'}`,
    [region_id, search, normalizedCategory, includeExpired]
  );

  return res.json({ posts: r.rows });
});

// Add gallery image for region (super or regional admin)
router.post('/galleries', authRequired, requireRole('super', 'regional_admin'), async (req, res) => {
  const { region_id, church_id, image_url, caption, location_link, expires_in_days } = req.body;
  if (!region_id || !image_url) return res.status(400).json({ error: 'Missing region_id or image_url' });

  const rr = await db.query('SELECT id FROM regions WHERE id=$1', [region_id]);
  if (rr.rowCount !== 1) return res.status(400).json({ error: 'Region not found' });

  if (req.user.role === 'regional_admin') {
    const allowedRegion = await userCanPostToRegion(req.user.id, region_id);
    if (!allowedRegion) return res.status(403).json({ error: 'Forbidden for this region' });
  }

  if (church_id) {
    const validChurch = await db.query('SELECT id FROM churches WHERE id=$1 AND region_id=$2', [church_id, region_id]);
    if (validChurch.rowCount !== 1) return res.status(400).json({ error: 'church_id is invalid for selected region' });
  }

  const expiresAt = parseExpiryDate(expires_in_days);
  if (expiresAt === undefined) return res.status(400).json({ error: 'expires_in_days must be a positive number' });

  const id = uuidv4();
  await db.query(
    `INSERT INTO region_galleries(
      id,author_id,region_id,church_id,caption,image_url,location_link,expires_at,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      id,
      req.user.id,
      region_id,
      church_id || null,
      caption || null,
      image_url,
      location_link || null,
      expiresAt
    ]
  );

  return res.json({ ok: true, id });
});

// Public list gallery images by region (newest first by default)
router.get('/galleries', async (req, res) => {
  const { region_id, search = '', sort = 'newest', include_expired = 'false' } = req.query;
  if (!region_id) return res.status(400).json({ error: 'Missing region_id' });

  const includeExpired = String(include_expired).toLowerCase() === 'true';
  const isNewest = sort !== 'oldest';

  const result = await db.query(
    `SELECT
      g.id,
      g.author_id,
      g.region_id,
      g.church_id,
      c.name AS church_name,
      g.caption,
      g.image_url,
      g.location_link,
      g.expires_at,
      g.created_at
    FROM region_galleries g
    LEFT JOIN churches c ON c.id = g.church_id
    WHERE g.region_id = $1
      AND ($2 = '' OR g.caption ILIKE '%' || $2 || '%')
      AND ($3::boolean = true OR g.expires_at IS NULL OR g.expires_at > NOW())
    ORDER BY g.created_at ${isNewest ? 'DESC' : 'ASC'}`,
    [region_id, search, includeExpired]
  );

  return res.json({ galleries: result.rows });
});

// Public list all gallery images across all regions (newest first by default)
router.get('/galleries/all', async (req, res) => {
  const { search = '', sort = 'newest', include_expired = 'false' } = req.query;

  const includeExpired = String(include_expired).toLowerCase() === 'true';
  const isNewest = sort !== 'oldest';

  const result = await db.query(
    `SELECT
      g.id,
      g.author_id,
      g.region_id,
      r.name AS region_name,
      g.church_id,
      c.name AS church_name,
      g.caption,
      g.image_url,
      g.location_link,
      g.expires_at,
      g.created_at
    FROM region_galleries g
    LEFT JOIN regions r ON r.id = g.region_id
    LEFT JOIN churches c ON c.id = g.church_id
    WHERE ($1 = '' OR g.caption ILIKE '%' || $1 || '%')
      AND ($2::boolean = true OR g.expires_at IS NULL OR g.expires_at > NOW())
    ORDER BY g.created_at ${isNewest ? 'DESC' : 'ASC'}`,
    [search, includeExpired]
  );

  return res.json({ galleries: result.rows });
});

module.exports = router;
