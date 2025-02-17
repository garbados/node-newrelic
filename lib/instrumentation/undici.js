/*
 * Copyright 2021 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const cat = require('../util/cat')
const recordExternal = require('../metrics/recorders/http_external')
const logger = require('../logger').child({ component: 'undici' })
const NAMES = require('../metrics/names')
const NEWRELIC_SYNTHETICS_HEADER = 'x-newrelic-synthetics'
const SYMBOLS = {
  SEGMENT: Symbol('__NR_segment'),
  PARENT_SEGMENT: Symbol('__NR_parent_segment')
}

let diagnosticsChannel = null
try {
  diagnosticsChannel = require('diagnostics_channel')
} catch (e) {
  // quick check to see if module exists
  // module was not added until v15.x
}

module.exports = function addUndiciChannels(agent, undici, modName, shim) {
  if (!diagnosticsChannel || !agent.config.feature_flag.undici_instrumentation) {
    logger.warn(
      'diagnostics_channel or feature_flag.undici_instrumentation = false. Skipping undici instrumentation.'
    )
    return
  }

  /**
   * This event occurs after the Undici Request is created
   * We will check current segment for opaque and also attach
   * relevant headers to outgoing http request
   *
   * @param {Object} params
   * @param {Object} params.request undici request object
   */
  diagnosticsChannel.channel('undici:request:create').subscribe(({ request }) => {
    const parent = shim.getSegment()
    request[SYMBOLS.PARENT_SEGMENT] = parent
    if (!parent || (parent && parent.opaque)) {
      logger.trace(
        'Not capturing data for outbound request (%s) because parent segment opaque (%s)',
        request.path,
        parent.name
      )

      return
    }

    const transaction = parent.transaction
    const outboundHeaders = Object.create(null)
    if (agent.config.encoding_key && transaction.syntheticsHeader) {
      outboundHeaders[NEWRELIC_SYNTHETICS_HEADER] = transaction.syntheticsHeader
    }

    if (agent.config.distributed_tracing.enabled) {
      transaction.insertDistributedTraceHeaders(outboundHeaders)
    } else if (agent.config.cross_application_tracer.enabled) {
      cat.addCatHeaders(agent.config, transaction, outboundHeaders)
    } else {
      logger.trace('Both DT and CAT are disabled, not adding headers!')
    }

    // eslint-disable-next-line guard-for-in
    for (const key in outboundHeaders) {
      request.addHeader(key, outboundHeaders[key])
    }
  })

  /**
   * This event occurs right before the data is written to the socket.
   * Undici has some abstracted headers that are only created at this time, one
   * is the `host` header which we need to name the Undici segment. So in this
   * handler we create, start and set the segment active, name it, and
   * attach the url/procedure/request.parameters
   *
   * @param {Object} params
   * @param {Object} params.request undicie request object
   * @param {TLSSocket | net.Socket} socket active socket connection
   *
   */
  diagnosticsChannel.channel('undici:client:sendHeaders').subscribe(({ request, socket }) => {
    const parentSegment = request[SYMBOLS.PARENT_SEGMENT]
    if (!parentSegment || (parentSegment && parentSegment.opaque)) {
      return
    }

    const port = socket.remotePort
    const isHttps = socket.servername
    let urlString
    if (isHttps) {
      urlString = `https://${socket.servername}`
      urlString += port === 443 ? request.path : `:${port}${request.path}`
    } else {
      urlString = `http://${socket._host}`
      urlString += port === 80 ? request.path : `:${port}${request.path}`
    }

    const url = new URL(urlString)

    const name = NAMES.EXTERNAL.PREFIX + url.host + url.pathname
    const segment = shim.createSegment(
      name,
      recordExternal(url.host, 'undici'),
      request[SYMBOLS.PARENT_SEGMENT]
    )
    segment.start()
    shim.setActiveSegment(segment)
    segment.addAttribute('url', `${url.protocol}//${url.host}${url.pathname}`)

    url.searchParams.forEach((value, key) => {
      segment.addSpanAttribute(`request.parameters.${key}`, value)
    })
    segment.addAttribute('procedure', request.method || 'GET')
    request[SYMBOLS.SEGMENT] = segment
  })

  /**
   * This event occurs after the response headers have been received.
   * We will add the relevant http response attributes to active segment.
   * Also add CAT specific keys to active segment.
   *
   * @param {Object} params
   * @param {Object} params.request undici request object
   * @param {Object} params.response { statusCode, headers, statusText }
   */
  diagnosticsChannel.channel('undici:request:headers').subscribe(({ request, response }) => {
    const activeSegment = request[SYMBOLS.SEGMENT]
    if (!activeSegment) {
      return
    }

    activeSegment.addSpanAttribute('http.statusCode', response.statusCode)
    activeSegment.addSpanAttribute('http.statusText', response.statusText)

    if (
      agent.config.cross_application_tracer.enabled &&
      !agent.config.distributed_tracing.enabled
    ) {
      try {
        const { appData } = cat.extractCatHeaders(response.headers)
        const decodedAppData = cat.parseAppData(agent.config, appData)
        const attrs = activeSegment.getAttributes()
        const url = new URL(attrs.url)
        cat.assignCatToSegment(decodedAppData, activeSegment, url.host)
      } catch (err) {
        logger.warn(err, 'Cannot add CAT data to segment')
      }
    }
  })

  /**
   * This event occurs after the response body has been received.
   * We will end the active segment and set the active back to parent before request
   * @param {Object} params.request undici request object
   */
  diagnosticsChannel.channel('undici:request:trailers').subscribe(({ request }) => {
    endAndRestoreSegment(request)
  })

  /**
   * This event occurs right before the request emits an error.
   * We will end the active segment and set the active back to parent before request.
   * We will also log errors to NR
   *
   * Note: This event occurs before the error handler so we will always log it for now.
   */
  diagnosticsChannel.channel('undici:request:error').subscribe(({ request, error }) => {
    endAndRestoreSegment(request, error)
  })

  /**
   * This event occurs before creating connection to socket.
   * We will create and start a segment for the `undici.Client.connect`
   *
   * @param {Object} params
   * @param {Function} params.connector function to connect to socket
   */
  diagnosticsChannel.channel('undici:client:beforeConnect').subscribe(({ connector }) => {
    const parent = shim.getSegment()
    const segment = shim.createSegment('undici.Client.connect')
    connector[SYMBOLS.SEGMENT] = segment
    connector[SYMBOLS.PARENT_SEGMENT] = parent
    segment.start()
    shim.setActiveSegment(segment)
  })

  /**
   * This event occurs when the socket connection has been made.
   * We will end the segment for the `undici.Client.connect` and restores parent
   * to before connect
   *
   * @param {Object} params
   * @param {Function} params.connector function to connect to socket
   */
  diagnosticsChannel.channel('undici:client:connected').subscribe(({ connector }) => {
    endAndRestoreSegment(connector)
  })

  /**
   * This event occurs when connection to socket fails.
   * We will end segment for the `undici.Client.connect` and restore parent
   * to before connect. It will also attach the error to the transaction
   *
   * @param {Object} params
   * @param {Function} params.connector function to connect to socket
   */
  diagnosticsChannel.channel('undici:client:connectError').subscribe(({ connector, error }) => {
    endAndRestoreSegment(connector, error)
  })

  /**
   * Gets the active and parent from given ctx(request, client connector)
   * and ends active and restores parent to active.  If an error exists
   * it will add the error to the transaction
   *
   * @param {Object} ctx request or client connector
   * @param {Error} error
   */
  function endAndRestoreSegment(ctx, error) {
    const activeSegment = ctx[SYMBOLS.SEGMENT]
    const parentSegment = ctx[SYMBOLS.PARENT_SEGMENT]
    if (activeSegment) {
      activeSegment.end()

      if (error) {
        handleError(activeSegment, error)
      }

      if (parentSegment) {
        shim.setActiveSegment(parentSegment)
      }
    }
  }

  /**
   * Adds the error to the active transaction
   *
   * @param {TraceSegment} activeSegment
   * @param {Error} error
   */
  function handleError(activeSegment, error) {
    logger.trace(error, 'Captured outbound error on behalf of the user.')
    const tx = activeSegment.transaction
    shim.agent.errors.add(tx, error)
  }
}

module.exports.SYMBOLS = SYMBOLS
