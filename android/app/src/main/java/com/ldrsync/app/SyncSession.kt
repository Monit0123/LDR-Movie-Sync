package com.ldrsync.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

data class ChatMessage(
    val name: String,
    val text: String,
    val mine: Boolean,
    val at: Long = System.currentTimeMillis(),
)

/**
 * App-wide sync session. One room, one socket, many screens that may be
 * listening (player, browser, lobby). Activities attach as Observers and
 * always read the latest snapshot from here, so rotating the phone or
 * switching screens never drops the connection.
 */
object SyncSession {

    interface Observer {
        fun onSyncStatus(connected: Boolean)
        fun onPeers(peers: List<Peer>)
        fun onRemote(message: JSONObject)
        fun onChat(message: ChatMessage)
    }

    private val observers = CopyOnWriteArrayList<Observer>()

    var client: SyncClient? = null
        private set

    var room: String = ""
        private set
    var displayName: String = ""
        private set
    var serverUrl: String = ""
        private set

    var connected: Boolean = false
        private set
    var peers: List<Peer> = emptyList()
        private set

    var currentSource: Source? = null
        private set
    var currentPosition: Double = 0.0
        private set
    var currentPaused: Boolean = true
        private set

    val messages = mutableListOf<ChatMessage>()
    var unread: Int = 0

    val partner: Peer?
        get() = peers.firstOrNull { it.id != client?.peerId }

    val isAlone: Boolean get() = partner == null

    // --------------------------------------------------------------- lifecycle

    fun connect(context: Context, serverBase: String, roomCode: String, name: String) {
        disconnect()

        room = roomCode.uppercase().filter { it.isLetterOrDigit() }
        displayName = name
        serverUrl = serverBase.trimEnd('/')

        val prefs = prefs(context)
        prefs.edit()
            .putString("server", serverUrl)
            .putString("name", displayName)
            .putString("lastRoom", room)
            .apply()

        connected = false
        peers = emptyList()
        unread = 0
        messages.clear()

        val created = SyncClient(object : SyncClient.Listener {
            override fun onStatus(connected: Boolean, detail: String?) {
                SyncSession.connected = connected
                if (!connected) {
                    peers = emptyList()
                } else {
                    client?.resync()
                }
                observers.forEach { it.onSyncStatus(connected) }
                if (!connected) observers.forEach { it.onPeers(emptyList()) }
            }

            override fun onPeers(peers: List<Peer>) {
                SyncSession.peers = peers
                observers.forEach { it.onPeers(peers) }
            }

            override fun onWelcome(peerId: String, peers: List<Peer>) {
                SyncSession.peers = peers
                observers.forEach { it.onPeers(peers) }
                observers.forEach { it.onSyncStatus(true) }
            }

            override fun onMessage(message: JSONObject) {
                when (message.optString("t")) {
                    "chat" -> {
                        val chat = ChatMessage(
                            name = message.optString("name", "Them"),
                            text = message.optString("text"),
                            mine = false,
                        )
                        messages.add(chat)
                        trimMessages()
                        observers.forEach { it.onChat(chat) }
                    }
                    "media" -> {
                        Source.fromJson(message.optJSONObject("source"))?.let { source ->
                            currentSource = source
                            currentPosition = message.optDouble("position", 0.0)
                            currentPaused = message.optBoolean("paused", true)
                        }
                        observers.forEach { it.onRemote(message) }
                    }
                    "play", "pause", "seek", "rate", "buffer" -> {
                        if (message.has("position")) {
                            currentPosition = SyncClient.expectedPosition(message, client?.serverNow() ?: 0.0)
                        }
                        if (message.optString("t") == "play") currentPaused = false
                        if (message.optString("t") == "pause") currentPaused = true
                        observers.forEach { it.onRemote(message) }
                    }
                }
            }
        })

        client = created
        created.connect(serverUrl, room, displayName)
    }

    fun disconnect() {
        client?.close()
        client = null
        connected = false
        peers = emptyList()
        currentSource = null
        currentPosition = 0.0
        currentPaused = true
    }

    fun sendChat(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        client?.chat(trimmed)
        val chat = ChatMessage(name = displayName, text = trimmed, mine = true)
        messages.add(chat)
        trimMessages()
        observers.forEach { it.onChat(chat) }
    }

    private fun trimMessages() {
        while (messages.size > 100) messages.removeAt(0)
    }

    fun rememberLocal(snapshot: Source, position: Double, paused: Boolean) {
        currentSource = snapshot
        currentPosition = position
        currentPaused = paused
    }

    fun addObserver(observer: Observer) {
        if (!observers.contains(observer)) observers.add(observer)
    }

    fun removeObserver(observer: Observer) {
        observers.remove(observer)
    }

    // ----------------------------------------------------------------- storage

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("flicksync", Context.MODE_PRIVATE)

    fun savedName(context: Context): String = prefs(context).getString("name", "").orEmpty()

    fun savedServer(context: Context): String =
        prefs(context).getString("server", BuildConfig.SERVER_URL).orEmpty()

    fun savedRoom(context: Context): String = prefs(context).getString("lastRoom", "").orEmpty()

    fun recent(context: Context): List<Source> {
        val raw = prefs(context).getString("recent", null) ?: return emptyList()
        return try {
            val array = org.json.JSONArray(raw)
            (0 until array.length()).mapNotNull { Source.fromJson(array.optJSONObject(it)) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun rememberRecent(context: Context, source: Source) {
        val list = recent(context).filterNot { it.key() == source.key() }.toMutableList()
        list.add(0, source)
        val array = org.json.JSONArray()
        list.take(8).forEach { array.put(it.toJson()) }
        prefs(context).edit().putString("recent", array.toString()).apply()
    }
}
