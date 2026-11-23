package com.ldrsync.app

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.ldrsync.app.databinding.ActivityWatchBinding
import com.ldrsync.app.databinding.DialogChatBinding
import org.json.JSONObject

/**
 * Native playback screen. The movie is fetched and decoded on this device;
 * only play/pause/seek travel over the relay.
 */
class WatchActivity : AppCompatActivity(), SyncSession.Observer {

    private lateinit var binding: ActivityWatchBinding
    private var player: ExoPlayer? = null

    private var source: Source? = null
    private var applyingRemote = false
    private var ignoreEventsUntil = 0L
    private var dragging = false
    private var waitingForPeer = false
    private var lastHeartbeat = 0.0
    private var lastRemote: JSONObject? = null
    private var chatDialog: BottomSheetDialog? = null
    private var chatBinding: DialogChatBinding? = null

    private val handler = Handler(Looper.getMainLooper())

    private val ticker = object : Runnable {
        override fun run() {
            renderProgress()
            correctDrift()
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWatchBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.roomChip.text = SyncSession.room.ifEmpty { "——" }
        setupPlayer()
        wireUi()
        restoreState()
    }

    override fun onStart() {
        super.onStart()
        SyncSession.addObserver(this)
        SyncSession.client?.resync()
        handler.post(ticker)
        renderPeers()
    }

    override fun onStop() {
        super.onStop()
        SyncSession.removeObserver(this)
        handler.removeCallbacks(ticker)
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        binding.playerView.player = null
        player?.release()
        player = null
        super.onDestroy()
    }

    // ------------------------------------------------------------------ player

    private fun setupPlayer() {
        val exo = ExoPlayer.Builder(this).build()
        player = exo
        binding.playerView.player = exo
        binding.playerView.useController = false
        binding.playerView.resizeMode = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
        binding.playerView.setShowBuffering(androidx.media3.ui.PlayerView.SHOW_BUFFERING_NEVER)

        exo.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                binding.playBtn.setImageResource(
                    if (isPlaying) R.drawable.ic_pause else R.drawable.ic_play,
                )
                if (isApplying()) return
                val pos = seconds()
                if (isPlaying) {
                    SyncSession.client?.play(pos)
                    remember(pos, false)
                } else if (exo.playbackState != Player.STATE_BUFFERING &&
                    exo.playbackState != Player.STATE_ENDED
                ) {
                    SyncSession.client?.pause(pos)
                    remember(pos, true)
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_BUFFERING -> {
                        binding.buffering.visibility = View.VISIBLE
                        binding.bufferChip.visibility = View.VISIBLE
                        binding.bufferChip.text = getString(R.string.buffering)
                        if (!isApplying()) SyncSession.client?.buffering(true)
                    }
                    Player.STATE_READY -> {
                        binding.buffering.visibility = View.GONE
                        binding.bufferChip.visibility = View.GONE
                        binding.idleText.visibility = View.GONE
                        if (!isApplying()) SyncSession.client?.buffering(false)
                    }
                    Player.STATE_ENDED -> {
                        binding.buffering.visibility = View.GONE
                        binding.bufferChip.visibility = View.GONE
                    }
                }
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int,
            ) {
                if (reason != Player.DISCONTINUITY_REASON_SEEK) return
                if (isApplying()) return
                SyncSession.client?.seek(seconds(), exo.playStateIsPaused())
                remember(seconds(), exo.playStateIsPaused())
            }

            override fun onPlayerError(error: PlaybackException) {
                binding.idleText.visibility = View.VISIBLE
                binding.idleText.text = "This stream could not be played here.\n${error.errorCodeName}"
                Toast.makeText(
                    this@WatchActivity,
                    "Could not play that link. Try the Browse tab instead.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        })
    }

    private fun Player.playStateIsPaused(): Boolean = !isPlaying

    private fun isApplying(): Boolean = applyingRemote || SystemClock.elapsedRealtime() < ignoreEventsUntil

    private fun seconds(): Double = (player?.currentPosition ?: 0L) / 1000.0

    private fun remember(position: Double, paused: Boolean) {
        source?.let { SyncSession.rememberLocal(it, position, paused) }
    }

    private fun restoreState() {
        val snapshot = SyncSession.currentSource
        if (snapshot != null) {
            loadSource(snapshot, SyncSession.currentPosition, SyncSession.currentPaused, broadcast = false)
        }
    }

    // --------------------------------------------------------------------- ui

    private fun wireUi() {
        binding.backBtn.setOnClickListener { finish() }
        binding.resyncBtn.setOnClickListener {
            player?.let {
                SyncSession.client?.seek(seconds(), !it.isPlaying)
                SyncSession.client?.send(if (it.isPlaying) "play" else "pause") { m ->
                    m.put("position", seconds())
                }
                toast("Sent your exact position")
            }
        }

        binding.playBtn.setOnClickListener { togglePlay() }

        binding.browseBtn.setOnClickListener {
            val current = source
            val url = current?.pageUrl ?: current?.url ?: "https://www.dailymotion.com"
            openBrowser(url, share = false)
        }

        binding.chatBtn.setOnClickListener { openChat() }

        binding.loadBtn.setOnClickListener { loadFromInput() }
        binding.urlInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                loadFromInput()
                true
            } else false
        }

        binding.seekBar.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: android.widget.SeekBar, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                dragging = true
                val duration = (player?.duration ?: 0L).coerceAtLeast(0L) / 1000.0
                if (duration > 0) binding.timeNow.text = (duration * progress / 1000.0).asClock()
            }

            override fun onStartTrackingTouch(seekBar: android.widget.SeekBar) {
                dragging = true
            }

            override fun onStopTrackingTouch(seekBar: android.widget.SeekBar) {
                dragging = false
                val duration = (player?.duration ?: 0L).coerceAtLeast(0L) / 1000.0
                if (duration <= 0) return
                val target = duration * seekBar.progress / 1000.0
                applyingRemote = true
                player?.seekTo((target * 1000).toLong())
                applyingRemote = false
                SyncSession.client?.seek(target, !(player?.isPlaying ?: false))
                remember(target, !(player?.isPlaying ?: false))
            }
        })
    }

    private fun togglePlay() {
        val p = player ?: run {
            toast("Load a video first")
            return
        }
        if (p.isPlaying) {
            p.pause()
            SyncSession.client?.pause(seconds())
            remember(seconds(), true)
        } else {
            p.play()
            SyncSession.client?.play(seconds())
            remember(seconds(), false)
        }
    }

    private fun loadFromInput() {
        val raw = binding.urlInput.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) return
        binding.loadBtn.isEnabled = false
        binding.syncLabel.text = "Resolving link…"

        SourceResolver.resolve(applicationContext, SyncSession.serverUrl, raw) { resolved ->
            binding.loadBtn.isEnabled = true
            if (isFinishing || isDestroyed) return@resolve
            if (resolved == null) {
                binding.syncLabel.text = getString(R.string.no_video_found)
                openBrowser(raw, share = false)
                return@resolve
            }
            loadSource(resolved, 0.0, paused = false, broadcast = true)
            SyncSession.client?.load(resolved, 0.0, false)
            binding.urlInput.setText("")
        }
    }

    /**
     * Load something into this device. `broadcast` tells the other side about it.
     */
    private fun loadSource(src: Source, position: Double, paused: Boolean, broadcast: Boolean) {
        source = src
        binding.titleText.text = src.displayTitle
        binding.idleText.visibility = View.GONE

        if (src.isEmbed || src.isBrowserOnly) {
            // Platform players and arbitrary pages need a real browser engine.
            val url = src.browserUrl()
            if (url != null) {
                // Don't let the previous native video keep playing audio under the browser.
                applyingRemote = true
                player?.let {
                    it.pause()
                    it.stop()
                    it.clearMediaItems()
                }
                applyingRemote = false
                binding.idleText.text = "Playing in the browser tab"
                binding.idleText.visibility = View.VISIBLE
                openBrowser(url, share = false)
                if (broadcast) SyncSession.client?.load(src, position, paused)
            } else {
                toast("Open that one in the browser tab")
            }
            return
        }

        val mediaUrl = src.playableUrl ?: return
        val p = player ?: return

        applyingRemote = true
        p.setMediaItem(MediaItem.fromUri(mediaUrl))
        p.prepare()
        if (position > 0) p.seekTo((position * 1000).toLong())
        if (paused) p.pause() else p.play()
        applyingRemote = false
        ignoreEventsUntil = SystemClock.elapsedRealtime() + 700

        SyncSession.rememberRecent(this, src)
        SyncSession.rememberLocal(src, position, paused)
        SyncService.start(this, src.displayTitle, peerStatus())

        if (broadcast) SyncSession.client?.load(src, position, paused)
    }

    private fun openBrowser(url: String, share: Boolean) {
        startActivity(
            Intent(this, BrowserActivity::class.java)
                .putExtra(BrowserActivity.EXTRA_URL, url)
                .putExtra(BrowserActivity.EXTRA_SHARE, share)
                .putExtra(BrowserActivity.EXTRA_POSITION, seconds())
                .putExtra(BrowserActivity.EXTRA_PAUSED, !(player?.isPlaying ?: false)),
        )
    }

    // ------------------------------------------------------------------- sync

    override fun onSyncStatus(connected: Boolean) {
        renderPeers()
    }

    override fun onPeers(peers: List<Peer>) {
        renderPeers()
    }

    override fun onChat(message: ChatMessage) {
        appendChatMessage(message)
    }

    private fun renderPeers() {
        val connected = SyncSession.connected
        val partner = SyncSession.partner
        binding.syncDot.setBackgroundResource(
            when {
                !connected -> R.drawable.dot_wait
                partner == null -> R.drawable.dot_idle
                else -> R.drawable.dot_live
            },
        )
        binding.syncLabel.text = when {
            !connected -> getString(R.string.reconnecting)
            partner == null -> getString(R.string.waiting_partner)
            else -> "In sync with ${partner.name}"
        }
        if (source != null && connected) {
            SyncService.update(this, source!!.displayTitle, peerStatus())
        }
    }

    private fun peerStatus(): String =
        SyncSession.partner?.let { "In sync with ${it.name}" } ?: getString(R.string.waiting_partner)

    override fun onRemote(message: JSONObject) {
        when (message.t("t")) {
            "media" -> {
                val incoming = Source.fromJson(message.optJSONObject("source")) ?: return
                lastRemote = message
                waitingForPeer = false
                binding.bufferChip.visibility = View.GONE

                if (source != null && source!!.key() == incoming.key()) {
                    // Same thing already loaded: just align.
                    applyPosition(message)
                    return
                }
                if (isFinishing || isDestroyed) return
                loadSource(
                    incoming,
                    position = SyncClient.expectedPosition(message, SyncSession.client?.serverNow() ?: 0.0),
                    paused = message.optBoolean("paused", true),
                    broadcast = false,
                )
            }

            "play", "pause", "seek", "rate" -> {
                lastRemote = message
                waitingForPeer = false
                binding.bufferChip.visibility = View.GONE
                applyPosition(message)
            }

            "buffer" -> {
                if (!message.optBoolean("buffering", false)) {
                    if (waitingForPeer) {
                        waitingForPeer = false
                        binding.bufferChip.visibility = View.GONE
                        lastRemote?.let { applyPosition(it) }
                    }
                    return
                }
                val p = player ?: return
                if (p.isPlaying) {
                    waitingForPeer = true
                    applyingRemote = true
                    p.pause()
                    applyingRemote = false
                    binding.bufferChip.visibility = View.VISIBLE
                    binding.bufferChip.text = getString(R.string.waiting_for_them)
                }
            }
        }
    }

    private fun applyPosition(message: JSONObject) {
        val p = player ?: return
        val now = SyncSession.client?.serverNow() ?: 0.0
        if (SyncClient.isStale(message, now)) return

        val target = SyncClient.expectedPosition(message, now)
        val wantsPause = when (message.t("t")) {
            "pause" -> true
            "play" -> false
            else -> message.optBoolean("paused", true)
        }

        val drift = Math.abs(seconds() - target)
        val tolerance = if (wantsPause) 0.3 else 1.1
        applyingRemote = true
        if (drift > tolerance) p.seekTo((target * 1000).toLong().coerceAtLeast(0L))
        if (wantsPause) {
            p.pause()
        } else if (!p.isPlaying) {
            p.play()
        }
        applyingRemote = false
        ignoreEventsUntil = SystemClock.elapsedRealtime() + 500
        remember(target, wantsPause)
    }

    // ------------------------------------------------------------------ drift

    private fun renderProgress() {
        val p = player ?: return
        val duration = (p.duration.coerceAtLeast(0L)) / 1000.0
        val position = p.currentPosition / 1000.0

        if (!dragging) {
            if (duration > 0) {
                binding.seekBar.progress = ((position / duration) * 1000).toInt().coerceIn(0, 1000)
            }
            binding.timeNow.text = position.asClock()
            binding.timeTotal.text = duration.asClock()
        }
        binding.playBtn.setImageResource(if (p.isPlaying) R.drawable.ic_pause else R.drawable.ic_play)
    }

    private fun correctDrift() {
        val p = player ?: return
        val client = SyncSession.client ?: return
        val remote = lastRemote ?: return
        if (waitingForPeer || dragging || applyingRemote) return
        if (!p.isPlaying) return
        if (remote.optBoolean("paused", true)) return

        val now = client.serverNow()
        if (SyncClient.isStale(remote, now)) return

        val target = SyncClient.expectedPosition(remote, now)
        if (Math.abs(p.currentPosition / 1000.0 - target) > 0.9) {
            applyingRemote = true
            p.seekTo((target * 1000).toLong().coerceAtLeast(0L))
            applyingRemote = false
            ignoreEventsUntil = SystemClock.elapsedRealtime() + 400
        }

        if (now - lastHeartbeat > 4000) {
            lastHeartbeat = now
            client.play(p.currentPosition / 1000.0)
        }
    }

    // ------------------------------------------------------------------- chat

    private fun openChat() {
        val sheet = BottomSheetDialog(this)
        val chatBinding = DialogChatBinding.inflate(LayoutInflater.from(this))
        sheet.setContentView(chatBinding.root)
        chatDialog = sheet
        this.chatBinding = chatBinding

        chatBinding.messages.removeAllViews()
        SyncSession.messages.forEach { appendChatMessage(it) }

        chatBinding.sendBtn.setOnClickListener { sendChatFromSheet() }
        chatBinding.chatInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendChatFromSheet()
                true
            } else false
        }
        sheet.setOnDismissListener {
            chatDialog = null
            this.chatBinding = null
        }
        sheet.show()
    }

    private fun sendChatFromSheet() {
        val chatBinding = chatBinding ?: return
        val text = chatBinding.chatInput.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        SyncSession.sendChat(text)
        chatBinding.chatInput.setText("")
    }

    private fun appendChatMessage(message: ChatMessage) {
        val chatBinding = chatBinding ?: return
        val bubble = TextView(this).apply {
            text = if (message.mine) message.text else "${message.name}: ${message.text}"
            setTextColor(ContextCompat.getColor(context, if (message.mine) R.color.white else R.color.text))
            textSize = 13f
            setBackgroundResource(if (message.mine) R.drawable.bg_bubble_me else R.drawable.bg_bubble_them)
            val padH = (12 * resources.displayMetrics.density).toInt()
            val padV = (8 * resources.displayMetrics.density).toInt()
            setPadding(padH, padV, padH, padV)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = (6 * resources.displayMetrics.density).toInt()
                gravity = if (message.mine) android.view.Gravity.END else android.view.Gravity.START
            }
        }
        chatBinding.messages.addView(bubble)
        chatBinding.scroll.post { chatBinding.scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }
}

/** Small helper so Kotlin reads nicely against JSONObject. */
fun JSONObject.t(key: String): String = optString(key, "")
