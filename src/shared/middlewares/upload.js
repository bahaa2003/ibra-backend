'use strict';

/**
 * upload.js — Multer middleware for deposit screenshot / proof uploads.
 *
 * Storage : disk  →  /uploads/deposits/<timestamp>-<random>.<ext>
 * Allowed  : jpg, jpeg, png, webp, pdf
 * Max size : 5 MB
 *
 * Usage in a route:
 *   router.post('/deposits', upload.single('screenshotProof'), handler);
 *
 * After the middleware runs, `req.file` contains the uploaded file metadata
 * including `req.file.filename` and `req.file.path`.
 */

const path = require('path');
const multer = require('multer');
const { BusinessRuleError } = require('../errors/AppError');

// ── Storage ───────────────────────────────────────────────────────────────────

const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'deposits');

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ts = Date.now();
        const rnd = Math.random().toString(36).slice(2, 8);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${ts}-${rnd}${ext}`);
    },
});

// ── File filter ───────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
]);

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

const fileFilter = (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.has(ext);

    if (!mimeOk || !extOk) {
        return cb(
            new BusinessRuleError(
                'Only JPG, JPEG, PNG, WebP, and PDF files are accepted.',
                'INVALID_FILE_TYPE'
            )
        );
    }
    cb(null, true);
};

// ── Multer instance ───────────────────────────────────────────────────────────

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024,   // 5 MB
        files: 1,
    },
});

module.exports = upload;
