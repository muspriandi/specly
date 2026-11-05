const express = require('express');
const { requireAdmin } = require('../../services/auth');

// Everything under /manage requires an active admin session.
const router = express.Router();
router.use(requireAdmin);
router.use('/users', require('./users'));
router.use('/invites', require('./invites'));
router.use('/requests', require('./requests'));
router.use('/blueprints', require('./blueprints'));
router.use('/trash', require('./trash'));
router.use('/audit', require('./audit'));

module.exports = router;
