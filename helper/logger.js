'use strict'

var _ = require('lodash')
var bunyan = require('bunyan')
var bunyanLogentries = require('bunyan-logentries')
var path = require('path')
var cls = require('continuation-local-storage')
var util = require('util')
var uuid = require('node-uuid')
var config = require('../config')

var REQ_RES_NAMESPACE = 'com.node-proxy.task-req-res'
var REQUEST_ID_KEY = 'reqId'
var USER_ID_KEY = 'userId'

var LOG_LEVEL_NAMES = ['trace', 'info', 'debug', 'warn', 'error', 'fatal']
var DEFAULT_LOG_LEVEL = 'info'

var reqResNamespace

var rootLogger
var rootLoggerName = 'live-studio'

var serializers = _.clone(bunyan.stdSerializers)
serializers.req = reqSerializer(bunyan.stdSerializers.req)
serializers.err = errSerializer(bunyan.stdSerializers.err)

/**
 * Initializes the logger. All logger configuration is set here.
 * @param  {Object} options hash with confuration options. Only option so far is
 * namespace, which can set the continuation local storage namespace
 */
function init (options) {
  options = options || {}
  var level = (options.level || config.get('log:level') || '').toLowerCase()
  var token = config.get('log:token')

    // Create the namespace to keep track of transaction ids for each request.
  reqResNamespace = cls.createNamespace(REQ_RES_NAMESPACE)
  patchCls(reqResNamespace)

    // Set log level
  if (LOG_LEVEL_NAMES.indexOf(level) < 0) {
    level = DEFAULT_LOG_LEVEL
  }

    // Setup streams. Always print out to the console.
  var streams = []

  if (!options.disableStdout) {
    streams.push({
      level: level,
      stream: process.stdout
    })
  }

  if (token) {
    streams.push({
      level: level,
      type: 'raw',
      stream: bunyanLogentries.createStream({
        token: token,
        secure: true,
                // Increase from default. If we are doing a bunch of logging of
                // there is network congestion, the default buffer of 100 fills
                // pretty fast, at which point we'll start losing logs.
        bufferSize: 10000
      })
    })
  }

    // Create the root logger with our options
  rootLogger = bunyan.createLogger({
    name: rootLoggerName,
    serializers: serializers,
    streams: streams
  })

    // If using logrotate or similar, we must send the SIGHUP signal to the node
    // process to signal that the log file is being rotated and that we should
    // reopen the new one here.
    //
    // We must rotate the file by creating a new file so that the rsyslog file
    // watcher can handle the rotation. Using truncate/copy would prevent us
    // from needing to do this, but would also prevent the watcher noticing the
    // change.
  process.on('SIGHUP', function () {
    rootLogger.info('Received SIGHUP. Reopening log files.')
    rootLogger.reopenFileStreams()
    rootLogger.info('Reopened log files.')
  })
}

/**
 * Patch modules that break continutation-local-storage. These monkey patch existing
 * promise libraries so that the reqId and userId, which are set for each request,
 * carry through the entire call chain.
 *
 * Add the try-catch so that the logger can still run without those modules.
 */
function patchCls (namespace) {
  var moduleNames = [
    'cls-bluebird',
    'cls-mongoose'
  ]

  moduleNames.forEach(function (name) {
    var m
    try {
      m = require(name)
    } catch (err) {}

    if (m) {
      m(namespace)
    }
  })
}

/**
 * Returns the logger to be used for the given module.
 *
 * If the calling module is passed in, it will resolve its path relative to the
 * the main directory and include that in the log output module field.
 *
 * Instead of returning underlying Bunyan logger, it returns a wrapper that can
 * check for and include a transaction id in the log. These ids are uniquely set
 * per request/response loop and allow logs for a give transaction to be linked
 * together. To accomplish this, it checks continuation local storage for a
 * transaction id. If it exists, it creates and uses a child logger that
 * includes the transation id.
 *
 * @param  {Object} callingModule Node module that is going to use the logger
 * @return {Object} logger object with six logging methods: trace, info, debug, warn, error, fatal
 */
var getLogger = function (callingModule) {
  if (!rootLogger) {
    init()
  }

  var moduleName
  if (typeof callingModule === 'string') {
    moduleName = callingModule
  } else if (callingModule && callingModule.filename && require.main) {
    var rootPath = path.dirname(require.main.filename)
    moduleName = path.relative(rootPath, callingModule.filename)
  }

  var options = {
    module: moduleName
  }
  var simple = true
  var baseLogger = rootLogger.child(options, simple)

  var logger = {}
  LOG_LEVEL_NAMES.forEach(function (level) {
    logger[level] = function log () {
      var reqId = reqResNamespace ? reqResNamespace.get(REQUEST_ID_KEY) : undefined
      var userId = reqResNamespace ? reqResNamespace.get(USER_ID_KEY) : undefined

            // Set the logger to use. If we have a namespace and reqId or userId,
            // then use a child logger seeded with those values.
      var loggerToUse = (reqId || userId) ? baseLogger.child({
        reqId: reqId,
        userId: userId
      }, simple) : baseLogger

            // Use the apply function to call the appropriate logging method and
            // pass through the given arguments as is.
      loggerToUse[level].apply(loggerToUse, arguments)
    }
  })

  return logger
}

/**
 * Middleware to set hi-resolution start time for calculating precise response
 * times.
 */
function setStartTime () {
  return function (req, res, next) {
    req.startTime = process.hrtime()
    return next()
  }
}

/**
 * Returns middleware to attach unique transaction id and user id to request.
 *
 * Creates continuation local storage bound to the request and response and stuff
 * a unique transaction id inside. This id will then be accessible from anywhere
 * in the code, so we can get it from our logging code and be able to tie
 * together all logs for a given request.
 *
 * https://datahero.com/blog/2014/05/22/node-js-preserving-data-across-async-callbacks/
 *
 * Also attach user id so that it is available throughout. I tried doing that in
 * a separate middleware, but I didn't understand enough about this CLS to make
 * that work. So for user id to be added, this middleware needs to be called
 * after the authentication, which means that the transaction id isn't available
 * to the earlier middleware, unfortunately.
 */
function setIds () {
  if (!reqResNamespace) {
    return function (req, res, next) {
      return next()
    }
  }

  return function (req, res, next) {
    var reqId = uuid.v4()
    var userId = req.user ? req.user._id : undefined
    reqResNamespace.bindEmitter(req)
    reqResNamespace.bindEmitter(res)
    reqResNamespace.run(function () {
      reqResNamespace.set(REQUEST_ID_KEY, reqId)
      reqResNamespace.set(USER_ID_KEY, userId)
      next()
    })
  }
}

/**
 * Converts hi-resolution time tuple (returned from process.hrtime()) to milliseconds
 * @param  {[number]} hr hi-resulution tuple [seconds, nanoseconds]
 * @return {number} milliseconds
 */
function hr2ms (hr) {
  var seconds = hr[0]
  var nanoseconds = hr[1]
  var milliseconds = (seconds * 1000) + (nanoseconds / 1000000)
  return milliseconds
}

/**
 * Returns middleware to log requests and responses
 * @param  {bunyan logger} logger
 */
function requestResponseLogger (logger, options) {
  options = options || {}
  var pathsToSkip = {};
  (options.pathsToSkip || []).forEach(function (path) {
    pathsToSkip[path] = true
  })

  return function reqResLogger (req, res, next) {
    if (pathsToSkip[req.path]) { return next() }

    logger.info({req: req}, 'Request received')

    function getOnResponse (level, msg) {
      return function onRespond () {
                // If the start time was set, calculate the response time. Node's
                // hrtime returns a  [seconds, nanoseconds] tuple, so we convert
                // that to milliseconds.
        var responseTimeInMs
        if (req.startTime) {
          var responseTimeHr = process.hrtime(req.startTime)
          responseTimeInMs = hr2ms(responseTimeHr)
        }

        logger[level]({
          req: req,
          res: res,
          responseTimeInMs: responseTimeInMs
        }, msg)
      }
    }

    res.on('close', getOnResponse('warn', 'Response closed'))
    res.on('finish', getOnResponse('info', 'Response sent'))

    next()
  }
}

/**
 * Use a custom request serializer to do the following:
 *
 * 1.) Mask authentication headers so we don't log this sensitve info
 * 2.) Use the original url - Express uses only the URL relative to the router
 */
function reqSerializer (stdSerialize) {
  return function serialize (req) {
    var serialized = stdSerialize(req)

    var shouldUpdateAuthorization = !!serialized.headers.authorization
    var shouldUpdateCookie = !!serialized.headers.cookie
    var shouldUpdateUrl = req.originalUrl && req.originalUrl !== req.url

    var shouldUpdate = shouldUpdateAuthorization || shouldUpdateCookie || shouldUpdateUrl
    if (!shouldUpdate) {
      return serialized
    }

        // Be careful not to modify the original request
    if (serialized === req) {
      serialized = _.clone(serialized)
    }

        // Mask the authorization header
    if (shouldUpdateAuthorization) {
      serialized.headers.authorization = maskAuthorization(serialized.headers.authorization)
    }

        // Mask the cookie header
    if (shouldUpdateCookie) {
      serialized.headers.cookie = maskCookie(serialized.headers.cookie)
    }

        // Use the original url
    if (shouldUpdateUrl) {
      serialized.url = req.originalUrl
    }

    return serialized
  }

    /**
     * Auth should be the form of "method token", i.e., "Bearer sfihpffpr09r73"
     *
     * We keep the method but strip the token so that we don't log out this
     * sensitive info.
     *
     * @param  {String} auth original authorization header
     * @return {String} masked authorization header
     */
  function maskAuthorization (auth) {
    var parts = auth.split(' ')
    if (parts.length !== 2) { return auth }
    return parts[0] + ' X'
  }

    /**
     * The cookie's sid is also sensitve info that we don't want in the logs
     *
     * @param  {String} auth cookie header
     * @return {String} masked cookie header
     */
  function maskCookie (cookie) {
    var cookies = cookie.split(';')
    var maskeCookies = cookies.map(function (cookie) {
      var parts = cookie.split('=')
      if (parts.length < 2) { return cookie }
      return parts[0] + '=X'
    })
    return maskeCookies.join(';')
  }
}

/**
 * Add handling to include mongoose validation error info
 */
function errSerializer (stdSerialize) {
  return function serialize (err) {
    var serialized = stdSerialize(err)
    for (var property in err) {
      if (!Object.prototype.hasOwnProperty.call(serialized, property) &&
            typeof (err[property]) !== 'function' &&
            ['stack', 'cause'].indexOf(property) < 0) {
        serialized[property] = err[property]
      }
    }

    // As a backup, in case we haven't gotten anything out of the error object,
    // fall back to the node inspect function to stringify it.
    try {
      if (Object.getOwnPropertyNames(serialized).length > 0) {
        serialized = util.inspect(serialized, {showHidden: true, depth: 4})
      }
    } catch (_) {}

    return serialized
  }
}

module.exports = getLogger
module.exports.init = init
module.exports.setStartTime = setStartTime
module.exports.setIds = setIds
module.exports.requestResponseLogger = requestResponseLogger
