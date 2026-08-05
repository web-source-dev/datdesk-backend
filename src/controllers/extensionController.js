const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const ManagedExtension = require('../models/ManagedExtension');

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '../../uploads');
const EXTENSIONS_DIR = path.join(UPLOADS_DIR, 'extensions');

function ensureExtensionsDir() {
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  }
}

function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'extension'
  );
}

function inspectExtensionZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (!entries.length) {
    throw Object.assign(new Error('ZIP archive is empty'), { status: 400 });
  }

  let manifestEntry = entries.find(
    (e) => !e.isDirectory && e.entryName.replace(/\\/g, '/') === 'manifest.json'
  );
  if (!manifestEntry) {
    manifestEntry = entries.find((e) => {
      if (e.isDirectory) return false;
      const name = e.entryName.replace(/\\/g, '/');
      return name.endsWith('/manifest.json');
    });
  }

  if (!manifestEntry) {
    throw Object.assign(
      new Error('ZIP must contain a Chromium extension (manifest.json)'),
      { status: 400 }
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid manifest.json in ZIP'), { status: 400 });
  }

  if (!manifest?.manifest_version) {
    throw Object.assign(new Error('manifest.json is missing manifest_version'), {
      status: 400
    });
  }

  return {
    name: typeof manifest.name === 'string' ? manifest.name : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    extensionId: manifest.extension_id || null
  };
}

async function listExtensions(_req, res) {
  try {
    const extensions = await ManagedExtension.find().sort({ createdAt: -1 });
    return res.json({ success: true, data: extensions });
  } catch (error) {
    console.error('[EXTENSION] List error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listEnabledForUser(_req, res) {
  try {
    const extensions = await ManagedExtension.find({ enabled: true })
      .select('name slug version description fileSize updatedAt createdAt')
      .sort({ name: 1 });

    return res.json({
      success: true,
      data: extensions.map((ext) => ({
        id: ext._id.toString(),
        name: ext.name,
        slug: ext.slug,
        version: ext.version,
        description: ext.description,
        fileSize: ext.fileSize,
        updatedAt: ext.updatedAt
      }))
    });
  } catch (error) {
    console.error('[EXTENSION] List enabled error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function uploadExtension(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: 'ZIP file is required (field: file)' });
    }

    const originalName = req.file.originalname || 'extension.zip';
    if (
      !/\.zip$/i.test(originalName) &&
      req.file.mimetype !== 'application/zip' &&
      req.file.mimetype !== 'application/x-zip-compressed'
    ) {
      return res.status(400).json({ message: 'Only .zip files are allowed' });
    }

    let inspected;
    try {
      inspected = inspectExtensionZip(req.file.buffer);
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }

    const name = (req.body.name || inspected.name || path.basename(originalName, '.zip')).trim();
    const slug = slugify(req.body.slug || name);
    const version = (req.body.version || inspected.version || '1.0.0').trim();
    const description = (req.body.description || '').trim();
    const enabled =
      req.body.enabled === undefined
        ? true
        : !(req.body.enabled === 'false' || req.body.enabled === false || req.body.enabled === '0');

    ensureExtensionsDir();
    const existing = await ManagedExtension.findOne({ slug });
    const storedFileName = `${slug}-${Date.now()}.zip`;
    const filePath = path.join(EXTENSIONS_DIR, storedFileName);
    fs.writeFileSync(filePath, req.file.buffer);

    if (existing) {
      if (existing.fileName) {
        const oldPath = path.join(EXTENSIONS_DIR, existing.fileName);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch {
            // ignore
          }
        }
      }
      existing.name = name;
      existing.version = version;
      existing.description = description;
      existing.fileName = storedFileName;
      existing.originalFileName = originalName;
      existing.fileSize = req.file.buffer.length;
      existing.enabled = enabled;
      if (inspected.extensionId) existing.extensionId = inspected.extensionId;
      await existing.save();
      return res.json({ success: true, message: 'Extension package updated', data: existing });
    }

    const created = await ManagedExtension.create({
      name,
      slug,
      version,
      description,
      fileName: storedFileName,
      originalFileName: originalName,
      fileSize: req.file.buffer.length,
      enabled,
      extensionId: inspected.extensionId || null
    });

    return res.status(201).json({ success: true, message: 'Extension uploaded', data: created });
  } catch (error) {
    console.error('[EXTENSION] Upload error:', error);
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An extension with this slug already exists' });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateExtension(req, res) {
  try {
    const ext = await ManagedExtension.findById(req.params.id);
    if (!ext) return res.status(404).json({ message: 'Extension not found' });

    const { name, version, description, enabled, slug } = req.body;
    if (name !== undefined) ext.name = String(name).trim();
    if (version !== undefined) ext.version = String(version).trim();
    if (description !== undefined) ext.description = String(description).trim();
    if (enabled !== undefined) ext.enabled = Boolean(enabled);
    if (slug !== undefined) {
      const nextSlug = slugify(slug);
      if (nextSlug !== ext.slug) {
        const clash = await ManagedExtension.findOne({ slug: nextSlug, _id: { $ne: ext._id } });
        if (clash) return res.status(409).json({ message: 'Slug already in use' });
        ext.slug = nextSlug;
      }
    }

    await ext.save();
    return res.json({ success: true, data: ext });
  } catch (error) {
    console.error('[EXTENSION] Update error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteExtension(req, res) {
  try {
    const ext = await ManagedExtension.findById(req.params.id);
    if (!ext) return res.status(404).json({ message: 'Extension not found' });

    if (ext.fileName) {
      const filePath = path.join(EXTENSIONS_DIR, ext.fileName);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }

    await ext.deleteOne();
    return res.json({ success: true, message: 'Extension deleted' });
  } catch (error) {
    console.error('[EXTENSION] Delete error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function downloadExtension(req, res) {
  try {
    const ext = await ManagedExtension.findById(req.params.id);
    if (!ext) return res.status(404).json({ message: 'Extension not found' });

    const isAdmin = req.user?.role === 'admin';
    if (!ext.enabled && !isAdmin) {
      return res.status(403).json({ message: 'Extension is not enabled' });
    }

    const filePath = path.join(EXTENSIONS_DIR, ext.fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Extension package file missing on server' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ext.slug}-${ext.version}.zip"`
    );
    res.setHeader('X-Extension-Slug', ext.slug);
    res.setHeader('X-Extension-Version', ext.version);

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[EXTENSION] Download stream error:', err);
      if (!res.headersSent) res.status(500).json({ message: 'Failed to stream extension' });
    });
    stream.pipe(res);
  } catch (error) {
    console.error('[EXTENSION] Download error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  listExtensions,
  listEnabledForUser,
  uploadExtension,
  updateExtension,
  deleteExtension,
  downloadExtension,
  ensureExtensionsDir,
  EXTENSIONS_DIR
};
