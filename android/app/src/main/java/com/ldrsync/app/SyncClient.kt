package com.ldrsync.app

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket client for the FlickSync relay.
 *
 * Owns the clock estimate (`offset`) that makes "issuedAt" comparable across
 * devices, keeps the socket alive with pings, and reconnects with backoff.
 * Callbacks are delivered on the main thread.
 */
class SyncClient(private val listener: Listener) {

    interface Listener {
        fun onStatus(connected: Boolean, detail: String?)
        fun onPeers(peers: List<Peer>)
        fun onWelcome(peerId: String, peers: List<Peer>)
        fun onMessage(message: JSONObject)
    }

    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var socket: WebSocket? = null
    private var baseUrl: String = ""
    private var room: String = ""
    private var displayName: String = ""
    private var userClosed = false
    private var attempt = 0
    private val samples = ArrayList<Pair<Double, Long>>()

    @Volatile var connected: Boolean = false
        private set

    @Volatile var offsetMs: Double = 0.0
        private set

    var peerId: String = ""
        private set

    var peers: List<Peer> = emptyList()
        private set

    private val pingTask = object : Runnable {
        override fun run() {
            sendRaw(JSONObject().put("t", "ping").put("c", System.currentTimeMillis()))
            main.postDelayed(this, 5000)
        }
    }

    // ---------------------------------------------------------------- connect

    fun connect(serverBase: String, roomCode: String, name: String) {
        baseUrl = serverBase.trimEnd('/')
        room = roomCode.uppercase().filter { it.isLetterOrDigit() }
        displayName = name
        userClosed = false
        attempt = 0
        open()
    }

    private fun open() {
        val wsBase = when {
            baseUrl.startsWith("https://") -> "wss://" + baseUrl.removePrefix("https://")
            baseUrl.startsWith("http://") -> "ws://" + baseUrl.removePrefix("http://")
            baseUrl.startsWith("ws") -> baseUrl
            else -> "wss://$baseUrl"
        }
        val url = "$wsBase/ws?room=${Source.encode(room)}&name=${Source.encode(displayName)}&device=android"

        socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                connected = true
                main.post {
                    listener.onStatus(true, null)
                    main.removeCallbacks(pingTask)
                    main.post(pingTask)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) = handle(text)

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected = false
                main.post { listener.onStatus(false, reason.ifBlank { null }) }
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected = false
                main.post { listener.onStatus(false, t.message) }
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (userClosed) return
        main.removeCallbacks(pingTask)
        val delay = (600L * Math.pow(1.7, attempt.toDouble())).toLong().coerceAtMost(8000L)
        attempt += 1
        main.postDelayed({ if (!userClosed) open() }, delay)
    }

    private fun handle(text: String) {
        val msg = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (msg.optString("t")) {
            "hello" -> {
                peerId = msg.optString("id")
                peers = Peer.list(msg.optJSONArray("peers"))
                val snapshot = peers
                main.post {
                    listener.onWelcome(peerId, snapshot)
                    listener.onPeers(snapshot)
                }
            }
            "join", "leave" -> {
                peers = Peer.list(msg.optJSONArray("peers"))
                val snapshot = peers
                main.post { listener.onPeers(snapshot) }
            }
            "pong" -> {
                val sent = msg.optLong("c", 0L)
                val serverTime = msg.optLong("s", 0L)
                if (sent <= 0L || serverTime <= 0L) return
                val now = System.currentTimeMillis()
                val rtt = now - sent
                if (rtt in 0..4000) {
                    synchronized(samples) {
                        samples.add(((serverTime - (sent + rtt / 2.0)) to rtt))
                        while (samples.size > 12) samples.removeAt(0)
                        val best = samples.sortedBy { it.second }.take(5).map { it.first }
                        offsetMs = best.sorted()[best.size / 2]
                    }
                }
            }
            else -> {
                main.post { listener.onMessage(msg) }
            }
        }
    }

    // ------------------------------------------------------------------ send

    fun serverNow(): Double = System.currentTimeMillis() + offsetMs

    private fun sendRaw(payload: JSONObject) {
        val ws = socket ?: return
        ws.send(payload.toString())
    }

    fun send(type: String, build: (JSONObject) -> Unit) {
        val payload = JSONObject().put("t", type).put("issuedAt", serverNow())
        build(payload)
        sendRaw(payload)
    }

    fun load(source: Source, position: Double, paused: Boolean) = send("media") {
        it.put("source", source.toJson())
        it.put("position", position)
        it.put("paused", paused)
    }

    fun play(position: Double) = send("play") { it.put("position", position) }

    fun pause(position: Double) = send("pause") { it.put("position", position) }

    fun seek(position: Double, paused: Boolean) = send("seek") {
        it.put("position", position)
        it.put("paused", paused)
    }

    fun buffering(isBuffering: Boolean) = send("buffer") { it.put("buffering", isBuffering) }

    fun rate(value: Float, position: Double) = send("rate") {
        it.put("rate", value)
        it.put("position", position)
    }

    fun chat(text: String) = send("chat") { it.put("text", text) }

    fun close() {
        userClosed = true
        main.removeCallbacks(pingTask)
        try {
            socket?.close(1000, "bye")
        } catch (_: Exception) {
        }
        socket = null
        connected = false
    }

    fun resync() {
        // Nudge: fresh clock sample, then a full state resend by the caller.
        sendRaw(JSONObject().put("t", "ping").put("c", System.currentTimeMillis()))
    }

    companion object {
        const val STALE_MS = 15_000.0

        fun expectedPosition(msg: JSONObject, serverNow: Double): Double {
            val base = msg.optDouble("position", 0.0)
            val issued = msg.optDouble("issuedAt", 0.0)
            if (issued <= 0.0) return base
            val elapsed = (serverNow - issued) / 1000.0
            if (elapsed < 0 || elapsed > 3600) return base
            return if (msg.optBoolean("paused", true)) base else base + elapsed
        }

        fun isStale(msg: JSONObject, serverNow: Double): Boolean {
            val issued = msg.optDouble("issuedAt", 0.0)
            return issued > 0 && serverNow - issued > STALE_MS
        }

        fun peersOf(json: JSONArray?): List<Peer> = Peer.list(json)
    }
}
