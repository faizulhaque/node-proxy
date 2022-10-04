
'use strict'

const logger = require('./logger')(module);
const async = require('async');
const http = require('http');
const createError = require('http-errors');
const querystring = require('querystring');

const config = require('../config')

const RETURN_CODE_SERVER_ERROR = 1
const RETURN_CODE_UNCAUGHT_EXCEPTION = 2
const RETURN_CODE_UNHANDLED_REJECTION = 3
const IS_SHUTTING_DOWN = 'isShuttingDown'

// How long to wait after attempting to gracefully shutdown before killing the process.
const SUICIDE_TIMEOUT_IN_MS = 5 * 1000

let app
let server
let secureServer

/**
 * Middleware to catch any requests with no matching routes. Needs to be the
 * last non-error handling middleware. If we had a special 404 page, we could
 * render it here, but for now, we just pass a notFound error and let the error
 * handler send the response.
 */
function notFoundHandler (req, res, next) {
  next(createError(404))
}

/**
 * Middleware to catch any errors.
 *
 * Logs error and responds with error page or json or text.
 */
function appErrorHandler (err, req, res, next) {
  var status = http.STATUS_CODES[err.status] ? err.status : 500
  res.status(status)

  var isClientError = status >= 400 && status < 500
  if (isClientError) {
    logger.info(err, 'Client error')
  } else {
    logger.error(err, 'Server error')
  }

  var code = isClientError ? err.code : undefined
  var message = (isClientError ? err.message : '') || http.STATUS_CODES[status]
  var stack = config.isLocal() ? err.stack : undefined

  var accepts = req.accepts(['json', 'html'])
  switch (accepts) {
    case 'json':
      res.json({
        code: code,
        message: message,
        stack: stack
      })
      break

    case 'html':
      if (status === 401) {
        var redirectUrl = '/?' +
                    querystring.stringify({
                      login: true,
                      redirect: req.originalUrl
                    })
        res.redirect(redirectUrl)
      } else {
        res.render('error', {
          title: status + ' ' + message,
          stack: stack,
          isClientError: isClientError
        })
      }
      break

    default:
      res.type('txt').send(message)
  }
}

/**
 * Handle and shutdown with style and grace. Close the server to new connections,
 * give it a chance to respond to connections in progress and kill it if it
 * doesn't come down on its own.
 */
function gracefulShutdown (killer) {
  if (!app) {
    return killer()
  }

  if (app.get(IS_SHUTTING_DOWN)) {
    logger.warn('Attempt to shut down while already shutting down...')
    return
  }

  logger.info('Shutting down gracefully...')
  app.set(IS_SHUTTING_DOWN, true)

  function closeServer (server, description) {
    return function (callback) {
      if (!server) {
        logger.info(description + ' not started')
        return callback()
      }

      logger.info('Closing ' + description.toLowerCase())
      server.close(function () {
        logger.info(description + ' closed')
        callback()
      })
    }
  }

    // Kick off the shutdown process.
  async.auto({
    closeServer: closeServer(server, 'Server'),
    closeSecureServer: closeServer(secureServer, 'Secure server'),
    shutdown: ['closeServer', 'closeSecureServer', killer]
  })

    // Set this to do a hard shutdown if we haven't gracefully shutdown after
    // a few seconds.
  setTimeout(function hardShutdown () {
    logger.info('Unable to shutdown gracefully')
    killer()
  }, SUICIDE_TIMEOUT_IN_MS)
}

/**
 * Grab a reference to the server and attach the error handler.
 */
function setServer (_server) {
  server = _server
  server.on('error', serverErrorHandler)
}

/**
 * Grab a reference to the secure server and attach the error handler.
 */
function setSecureServer (_server) {
  secureServer = _server
  secureServer.on('error', serverErrorHandler)
}

/**
 * Grab a reference to the db for closing connections on shutdown.
 */
function setDatabaseConnection (_databaseConnection) {
  databaseConnection = _databaseConnection
}

/**
 * Middleware for graceful shutdown. Should be first middleware in the stack.
 * Checks if in shutdown mode and closes out any keep-alive connections. Node
 * already handles new connections but supposedly this handles those already open.
 */
function gracefulShutdownMiddleware (_app) {
  app = _app

  app.set(IS_SHUTTING_DOWN, false)

  return function (req, res, next) {
    if (app.get(IS_SHUTTING_DOWN)) {
      req.connection.setTimeout(1)
    }

    next()
  }
}

/**
 * Handle uncaught server errors. All we can really do here is just push a
 * proper entry into the logs and then shut down. Any exception caught here
 * would be asynchronous, so even if the error was thrown while handling a
 * request, we can't even send back a response.
 */
function serverErrorHandler (err) {
  var message = 'Uncaught server error'

  if (err.code === 'EADDRINUSE') {
    message += '. Port is in use. There is likely another instance of the server already running.'
  }

  logger.fatal(err, message)
  gracefulShutdown(function killer () {
    exitWithStatus(RETURN_CODE_SERVER_ERROR)
  })
}

/**
 * Attaches handler to the process to handle any uncaught exceptions. We can't
 * really do anything but properly log the and then gracefully shutdown.
 */
function handleUncaughtExceptions () {
  process.once('uncaughtException', function (err) {
    if (err.code === 'ECONNRESET') {
      logger.error({err: err}, 'Exception suppressed. Check request logs')
      return
    }

    logger.fatal(err, 'Uncaught exception')
    gracefulShutdown(function killer () {
      exitWithStatus(RETURN_CODE_UNCAUGHT_EXCEPTION)
    })
  })

  process.on('unhandledRejection', function (reason, promise) {
    logger.fatal({err: reason, promise: promise}, 'Unhandled rejection')
    gracefulShutdown(function killer () {
      exitWithStatus(RETURN_CODE_UNHANDLED_REJECTION)
    })
  })
}

/**
 * Exits the application by killing the process
 * @param  {Integer} status exit status
 */
function exitWithStatus (status) {
  logger.info({ status: status }, 'Exiting process')
  process.nextTick(function () {
    process.exit(status)
  })
}

/**
 * Returns function to handle a kill signal. Logs it and gracefully shuts down.
 * @param  {string} signal
 * @return {function} handler
 */
function killSignalHandler (signal) {
  function killer () {
    process.kill(process.pid, signal)
  }

  return function () {
    logger.info({
      signal: signal
    }, 'Kill signal received')

    gracefulShutdown(killer)
  }
}

/**
 * Attaches handlers to several kill signals to properly handle them.
 */
function handleKillSignals () {
  var killSignals = [
    'SIGUSR2', // Nodemon
    'SIGINT', // Ctrl+C
    'SIGTERM' // Kill
  ]

  killSignals.forEach(function (signal) {
    process.once(signal, killSignalHandler(signal))
  })
}

module.exports = {
  notFoundHandler: notFoundHandler,
  appErrorHandler: appErrorHandler,
  gracefulShutdownMiddleware: gracefulShutdownMiddleware,
  setServer: setServer,
  setSecureServer: setSecureServer,
  setDatabaseConnection: setDatabaseConnection,
  handleUncaughtExceptions: handleUncaughtExceptions,
  handleKillSignals: handleKillSignals
}
