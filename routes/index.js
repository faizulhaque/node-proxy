'use strict'

const logger = require('../helper/logger')(module);
const got = require('got');

module.exports = (app) => {

  app.get('/', async (req, res, next) => {
    logger.info('call:received:/:', req.params, req.query);
    res.json({
      env: process.env.NODE_ENV
    });
  });

  app.post('/proxy', (req, res, next) => {
    logger.info('call:received:/:', {params: req.params, query: req.query, body: req.body});

    req.body = req.body || {};
    
    if (!req.body.url) {
      return res.status(400).json({
        message: '"url" is missing.'
      });
    }

    if (!req.body.method) {
      return res.status(400).json({
        message: '"method" is missing.'
      });
    }
    let options = {
      method: req.body.method
    };

    if (req.body.body) {
      options.body = JSON.stringify(req.body.body);
    }

    if (req.body.timeout) {
      options.timeout = req.body.timeout
    }

    if (req.body.retries) {
      options.retries = req.body.retries
    }

    if (req.body.headers) {
      options.headers = req.body.headers
    }

    logger.info('proxy calling', {url: req.body.url, options: options});
    return got(req.body.url, options)
      .then(function (response) {
        res.json(JSON.parse(response.body));
      })
      .then(null, function (err) {
        logger.error({ fullUrl: req.body.url, err: err, statusCode: err.statusCode }, 'proxy request error')
        return res.status(400).json({
          err: err
        });
      });
  });

}
