'use strict';

const logger = require('./helper/logger')(module);
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const https = require('https');
const http = require('http');
const fs = require('fs');
const config = require('./config');
const routes = require('./routes');
const errorHandlers = require('./helper/errors');

app.set("view engine", "ejs");
app.use(express.static("public"));

app.use(bodyParser.json({limit: '50mb'}))
app.use(bodyParser.urlencoded({
  extended: true
}))

let server;
if (config.isLocal()) {
  server = https.createServer({
    key: fs.readFileSync('./ssl/server.key'),
    cert: fs.readFileSync('./ssl/server.cert'),
    requestCert: false,
    rejectUnauthorized: false
  }, app);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
} else {
  server = http.createServer(app);
}

errorHandlers.handleUncaughtExceptions()
errorHandlers.handleKillSignals()

const port = process.env.PORT || config.get('server:port')
//web app
logger.info('Starting Express Web Server on Port ' + port)

routes(app);

app.use(errorHandlers.gracefulShutdownMiddleware(app))
app.use(errorHandlers.notFoundHandler)
app.use(errorHandlers.appErrorHandler)

server.listen(port, async () => {
  errorHandlers.setServer(server)
});
