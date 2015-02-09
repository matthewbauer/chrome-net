var inherits = require('inherits')
var ipaddr = require('ipaddr.js')
var stream = require('stream')
var is = require('core-util-is')

inherits(Socket, stream.Duplex)

function Socket (options) {
	var self = this
	if (!(self instanceof Socket)) return new Socket(options)

	if (options === undefined)
		options = {}

	stream.Duplex.call(self, options)

	self.destroyed = false
	self.errorEmitted = false
	self.readable = self.writable = false

	// The amount of received bytes.
	self.bytesRead = 0

	self._bytesDispatched = 0
	self._connecting = false

	self.ondata = null
	self.onend = null

	self._hasConnected = false

	chrome.sockets.tcp.create({}, function(createInfo) {
		self.id = createInfo.socketId;
		self.emit('create');
		chrome.sockets.tcp.onReceive.addListener(function(info) {
			if (self.id == info.socketId) {
				self._onReceive(info.data);
			}
		});
		chrome.sockets.tcp.onReceiveError.addListener(function(info) {
			if (self.id == info.socketId) {
				self._onReceiveError(info.resultCode);
			}
		});
	});
}
exports.Socket = Socket

Socket.prototype.connect = function() {
	var args = normalizeConnectArgs(arguments)
	var s = this
	return Socket.prototype._connect.apply(s, args)
}

Socket.prototype._connect = function (options, cb) {
	var self = this

	if (self._connecting)
		return
	self._connecting = true

	var port = Number(options.port)

	if (is.isFunction(cb)) {
		self.once('connect', cb)
	}

	self._hasSocketId(function() {
		chrome.sockets.tcp.connect(self.id, options.host, port, function (result) {
			if (result < 0) {
				self.destroy(new Error('Socket ' + self.id + ' connect error ' + result
					+ ': ' + chrome.runtime.lastError.message))
				return
			}
			self._onConnect()
		})
	})

	return self
}

Socket.prototype._onConnect = function () {
	var self = this

	chrome.sockets.tcp.getInfo(self.id, function (result) {
		self.remoteAddress = result.peerAddress
		self.remotePort = result.peerPort
		self.localAddress = result.localAddress
		self.localPort = result.localPort

		self._connecting = false
		self.readable = self.writable = true

		self.emit('connect')
		self._hasConnected = true
		self.read(0)
	})
}

Socket.prototype._onConnected = function(callback) {
	if (this._hasConnected) {
		callback();
	} else {
		this.once('connect', callback);
	}
}

Socket.prototype._hasSocketId = function(callback) {
	if (this.id) {
		callback();
	} else {
		this.on('create', callback);
	}
}

Object.defineProperty(Socket.prototype, 'bufferSize', {
	get: function () {
		var self = this
		if (self._pendingData)
			return self._pendingData.length
		else
			return 0 // Unfortunately, chrome.socket does not make this info available
	}
})

Socket.prototype.write = function (chunk, encoding, callback) {
	var self = this
	if (!Buffer.isBuffer(chunk))
		chunk = new Buffer(chunk, encoding)

	return stream.Duplex.prototype.write.call(self, chunk, encoding, callback)
}

Socket.prototype._write = function (buffer, encoding, callback) {
	var self = this
	if (!callback) callback = function () {}

	if (!self.writable) {
		self._pendingData = buffer
		self._pendingEncoding = encoding
		self.on('connect', function () {
			self._write(buffer, encoding, callback)
		})
		return
	}
	self._pendingData = null
	self._pendingEncoding = null

	// assuming buffer is browser implementation (`buffer` package on npm)
	var buf = buffer.buffer
	if (buffer.byteOffset || buffer.byteLength !== buf.byteLength)
		buf = buf.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

	chrome.sockets.tcp.send(self.id, buf, function (sendInfo) {
		if (sendInfo.resultCode < 0) {
			var err = new Error('Socket ' + self.id + ' write error: ' + sendInfo.resultCode)
			callback(err)
			self.destroy(err)
		} else {
			self._resetTimeout()
			callback(null)
		}
	})

	self._bytesDispatched += buffer.length
}

Socket.prototype._read = function (bufferSize) {
	var self = this
	if (self._connecting) {
		self.once('connect', self._read.bind(self, bufferSize))
		return
	}

	self._hasSocketId(function() {
		chrome.sockets.tcp.setPaused(self.id, false)
	})
}

Socket.prototype.pause = function() {
	self._hasSocketId(function() {
		chrome.sockets.tcp.setPaused(self.id, true)
	});
}

Socket.prototype._onReceive = function (data) {
	var self = this
	var buffer = new Buffer(new Uint8Array(data))
	var offset = self.bytesRead

	self.bytesRead += buffer.length
	self._resetTimeout()

	if (self.ondata) self.ondata(buffer, offset, self.bytesRead)
	if (!self.push(buffer)) { // if returns false, then apply backpressure
		self._hasSocketId(function() {
			chrome.sockets.tcp.setPaused(self.id, true)
		});
	}
}

Socket.prototype._onReceiveError = function (resultCode) {
	var self = this
	if (resultCode === -100) {
		if (self.onend) self.once('end', self.onend)
		self.push(null)
		self.destroy()
	} else if (resultCode < 0) {
		self.destroy(new Error('Socket ' + self.id + ' receive error ' + resultCode))
	}
}

/**
 * The amount of bytes sent.
 * @return {number}
 */
Object.defineProperty(Socket.prototype, 'bytesWritten', {
	get: function () {
		var self = this
		var bytes = self._bytesDispatched

		self._writableState.toArrayBuffer().forEach(function (el) {
			if (Buffer.isBuffer(el.chunk))
				bytes += el.chunk.length
			else
				bytes += new Buffer(el.chunk, el.encoding).length
		})

		if (self._pendingData) {
			if (Buffer.isBuffer(self._pendingData))
				bytes += self._pendingData.length
			else
				bytes += Buffer.byteLength(self._pendingData, self._pendingEncoding)
		}

		return bytes
	}
})

Socket.prototype.destroy = function (exception) {
	var self = this
	self._destroy(exception)
}

Socket.prototype._destroy = function (exception, cb) {
	var self = this

	function fireErrorCallbacks () {
		if (cb) cb(exception)
		if (exception && !self.errorEmitted) {
			process.nextTick(function () {
				self.emit('error', exception)
			})
			self.errorEmitted = true
		}
	}

	if (self.destroyed) {
		// already destroyed, fire error callbacks
		fireErrorCallbacks()
		return
	}

	if (this.server) {
		this.server._connections -= 1
	}

	self._connecting = false
	this.readable = this.writable = false
	self.destroyed = true

	// if _destroy() has been called before chrome.sockets.tcp.create()
	// callback, we don't have an id. Therefore we don't need to close
	// or disconnect
	if (self.id) {
		chrome.sockets.tcp.disconnect(self.id, function () {
			chrome.sockets.tcp.close(self.id, function () {
				self.emit('close', !!exception)
				fireErrorCallbacks()
			})
		})
	}
}

Socket.prototype.destroySoon = function () {
	var self = this

	if (self.writable)
		self.end()

	if (self._writableState.finished)
		self.destroy()
	else
		self.once('finish', self._destroy.bind(self))
}

/**
 * Sets the socket to timeout after timeout milliseconds of inactivity on the socket.
 * By default net.Socket do not have a timeout. When an idle timeout is triggered the
 * socket will receive a 'timeout' event but the connection will not be severed. The
 * user must manually end() or destroy() the socket.
 *
 * If timeout is 0, then the existing idle timeout is disabled.
 *
 * The optional callback parameter will be added as a one time listener for the 'timeout' event.
 *
 * @param {number}   timeout
 * @param {function} callback
 */
Socket.prototype.setTimeout = function (timeout, callback) {
	var self = this
	if (callback) self.once('timeout', callback)
	self._timeoutMs = timeout
	self._resetTimeout()
}

Socket.prototype._onTimeout = function () {
	var self = this
	self._timeout = null
	self._timeoutMs = 0
	self.emit('timeout')
}

Socket.prototype._resetTimeout = function () {
	var self = this
	if (self._timeout) {
		clearTimeout(self._timeout)
	}
	if (self._timeoutMs) {
		self._timeout = setTimeout(self._onTimeout.bind(self), self._timeoutMs)
	}
}

/**
 * Disables the Nagle algorithm. By default TCP connections use the Nagle
 * algorithm, they buffer data before sending it off. Setting true for noDelay
 * will immediately fire off data each time socket.write() is called. noDelay
 * defaults to true.
 *
 * NOTE: The Chrome version of this function is async, whereas the node
 * version is sync. Keep this in mind.
 *
 * @param {boolean} [noDelay] Optional
 * @param {function} callback CHROME-SPECIFIC: Called when the configuration
 *                            operation is done.
 */
Socket.prototype.setNoDelay = function (noDelay, callback) {
	var self = this
	// backwards compatibility: assume true when `enable` is omitted
	noDelay = is.isUndefined(noDelay) ? true : !!noDelay
	if (!callback) callback = function () {}
	chrome.sockets.tcp.setNoDelay(self.id, noDelay, callback)
}

/**
 * Enable/disable keep-alive functionality, and optionally set the initial
 * delay before the first keepalive probe is sent on an idle socket. enable
 * defaults to false.
 *
 * Set initialDelay (in milliseconds) to set the delay between the last data
 * packet received and the first keepalive probe. Setting 0 for initialDelay
 * will leave the value unchanged from the default (or previous) setting.
 * Defaults to 0.
 *
 * NOTE: The Chrome version of this function is async, whereas the node
 * version is sync. Keep this in mind.
 *
 * @param {boolean} [enable] Optional
 * @param {number} [initialDelay]
 * @param {function} callback CHROME-SPECIFIC: Called when the configuration
 *                            operation is done.
 */
Socket.prototype.setKeepAlive = function (enable, initialDelay, callback) {
	var self = this
	self._onConnected(function() {
		if (!callback) callback = function () {}
		chrome.sockets.tcp.setKeepAlive(self.id, !!enable, ~~(initialDelay / 1000),
			callback)
	});
}

/**
 * Returns the bound address, the address family name and port of the socket
 * as reported by the operating system. Returns an object with three
 * properties, e.g. { port: 12346, family: 'IPv4', address: '127.0.0.1' }
 *
 * @return {Object} information
 */
Socket.prototype.address = function () {
	var self = this
	return {
		address: self.localAddress,
		port: self.localPort,
		family: 'IPv4'
	}
}

Object.defineProperty(Socket.prototype, 'readyState', {
	get: function () {
		var self = this
		if (self._connecting) {
			return 'opening'
		} else if (self.readable && self.writable) {
			return 'open'
		} else {
			return 'closed'
		}
	}
})

Socket.prototype.unref = function () {
	// No chrome.socket equivalent
}

Socket.prototype.ref = function () {
	// No chrome.socket equivalent
}

//
// EXPORTED HELPERS
//

exports.isIP = function (input) {
	try {
		ipaddr.parse(input)
	} catch (e) {
		return false
	}
	return true
}

exports.isIPv4 = function (input) {
	try {
		var parsed = ipaddr.parse(input)
		return (parsed.kind() === 'ipv4')
	} catch (e) {
		return false
	}
}

exports.isIPv6 = function (input) {
	try {
		var parsed = ipaddr.parse(input)
		return (parsed.kind() === 'ipv6')
	} catch (e) {
		return false
	}
}

//
// HELPERS
//

/**
 * Returns an array [options] or [options, cb]
 * It is the same as the argument of Socket.prototype.connect().
 */
function normalizeConnectArgs (args) {
	var options = {}

	if (is.isObject(args[0])) {
		// connect(options, [cb])
		options = args[0]
	} else {
		// connect(port, [host], [cb])
		options.port = args[0]
		if (is.isString(args[1])) {
			options.host = args[1]
		} else {
			options.host = '127.0.0.1'
		}
	}

	var cb = args[args.length - 1]
	return is.isFunction(cb) ? [options, cb] : [options]
}

function toNumber (x) {
	return (x = Number(x)) >= 0 ? x : false
}
