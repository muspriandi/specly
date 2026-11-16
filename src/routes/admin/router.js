const express = require('express');
const { numericParam } = require('../../lib/http');

// Router whose :id / :vid params must be numeric (404 otherwise).
module.exports = () => {
  const router = express.Router();
  router.param('id', numericParam);
  router.param('vid', numericParam);
  router.param('uid', numericParam);
  router.param('bid', numericParam);
  router.param('sid', numericParam);
  return router;
};
