package com.ldrsync.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import com.ldrsync.app.databinding.ActivityBrowserBinding
import org.json.JSONObject

/**
 * The contained browser.
 *
 * Whatever page she opens here — Dailymotion, an embed, any site with a <video>
 * — is detected by an injected script, and the *page URL plus playhead* is
 * mirrored to the other device. Both sides then stream it themselves; nothing
 * is ever re-encoded or screen-shared.
 */
class BrowserActivity : AppCompatActivity(), SyncSession.Observer {

    private lateinit var binding: ActivityBrowserBinding
    private var lastEvent: JSONObject? = null
    private var lastRemote: JSONObject? = null
    private var sharedKey: String? = null
    /** What we last asked the WebView to load (before any redirect). */
    private var loadedTarget: String? = null
    /** Frames we have stepped into, so a page cannot bounce us in circles. */
    private val hopSeen = mutableSetOf<String>()
    private var hopCount = 0
    /** The site that framed the player we are now inside. */
    private var frameParent: String? = null
    private var suppressShareUntil = 0L
    private var pendingPosition: Double? = null
    private var pendingPlaying = false
    private var lastHeartbeat = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBrowserBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setupWebView()
        wireUi()

        val url = intent.getStringExtra(EXTRA_URL)
        val referer = intent.getStringExtra(EXTRA_REFERER)
        pendingPosition = intent.getDoubleExtra(EXTRA_POSITION, 0.0)
        pendingPlaying = !intent.getBooleanExtra(EXTRA_PAUSED, true)
        if (!url.isNullOrBlank()) {
            load(url, referer)
        } else {
            val start = SyncSession.currentSource?.pageUrl ?: "https://www.dailymotion.com"
            load(start)
        }
    }

    override fun onStart() {
        super.onStart()
        SyncSession.addObserver(this)
        renderStatus()
    }

    override fun onStop() {
        super.onStop()
        SyncSession.removeObserver(this)
    }

    override fun onDestroy() {
        binding.webView.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------------- setup

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportMultipleWindows(false)
            userAgentString = userAgentString.replace("; wv", "").replace("Version/4.0 ", "")
        }
        binding.webView.addJavascriptInterface(
            Bridge { json -> runOnUiThread { onPageEvent(json) } },
            Bridge.NAME,
        )

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                inject()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                inject()
                url?.let { binding.addressInput.setText(it) }
                renderStatus()
                // Pages create their <video> late; keep poking gently.
                listOf(600L, 1800L, 4000L).forEach { delay ->
                    binding.webView.postDelayed({ inject() }, delay)
                }
            }

            /**
             * A relay older than this build has no /embed shim, so the bounce
             * page 404s. Go straight to the player instead of showing an error.
             */
            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?,
            ) {
                val url = request?.url?.toString() ?: return
                val status = errorResponse?.statusCode ?: 0
                if (status !in 400..499) return
                val original = Embeds.unwrap(url, relayBase()) ?: return
                load(original, Embeds.referer(relayBase()))
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val target = request?.url?.toString() ?: return false
                if (!target.startsWith("http://") && !target.startsWith("https://")) return true
                // Only a real tap may jump to the native player. Ad redirects
                // land on .mp4s all the time and must not close the browser.
                if (isDirectMedia(target) && request?.hasGesture == true) {
                    handOffToPlayer(target)
                    return true
                }
                return false
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack() else finish()
            }
        })
    }

    private fun wireUi() {
        binding.backBtn.setOnClickListener { finish() }
        binding.webBackBtn.setOnClickListener { if (binding.webView.canGoBack()) binding.webView.goBack() }
        binding.webForwardBtn.setOnClickListener { if (binding.webView.canGoForward()) binding.webView.goForward() }
        binding.goBtn.setOnClickListener { go() }
        binding.addressInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                go()
                true
            } else false
        }
        binding.sendBtn.setOnClickListener { shareCurrent(force = true) }
        binding.resyncBtn.setOnClickListener {
            val position = lastEvent?.optDouble("position", 0.0) ?: 0.0
            val paused = lastEvent?.optBoolean("paused", true) ?: true
            applyToPage(if (paused) "pause" else "play", position)
            SyncSession.client?.seek(position, paused)
            SyncSession.client?.send(if (paused) "pause" else "play") { it.put("position", position) }
        }
    }

    private fun go() {
        val raw = binding.addressInput.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) return
        hopSeen.clear()
        hopCount = 0
        frameParent = null
        val url = when {
            raw.startsWith("http") -> raw
            raw.contains(".") && !raw.contains(" ") -> "https://$raw"
            else -> "https://duckduckgo.com/?q=" + java.net.URLEncoder.encode(raw, "UTF-8")
        }
        if (isDirectMedia(url)) handOffToPlayer(url) else load(url)
    }

    private fun load(url: String, referer: String? = null) {
        loadedTarget = url
        val relay = relayBase()
        val target = Embeds.wrap(url, relay)
        val headers = when {
            // Embed players routinely refuse to run unless the site that framed
            // them is the referrer — so keep pretending to be that site.
            referer != null -> mapOf("Referer" to referer)
            // No relay to bounce through: give the player a referrer directly.
            target == url && Embeds.isEmbedUrl(url) -> mapOf("Referer" to Embeds.referer(relay))
            else -> emptyMap()
        }
        if (headers.isEmpty()) {
            binding.webView.loadUrl(target)
        } else {
            binding.webView.loadUrl(target, headers)
        }
        binding.webView.requestFocus()
        renderStatus()
    }

    /**
     * Step into the framed player.
     *
     * Streaming sites almost never hold the <video> in the page you open: the
     * watch page frames a player on a different host, and a page script can
     * never reach into a cross-origin frame. Navigating the WebView *into* the
     * frame makes the player the top document, where the bridge can drive it.
     */
    private fun followEmbeddedPlayer(event: JSONObject) {
        if (hopCount >= MAX_HOPS) {
            binding.syncLabel.text = "No video found here — press play in the page, or open another player"
            return
        }
        val frames = event.optJSONArray("frames") ?: return
        val from = loadedTarget ?: binding.webView.url ?: return

        for (i in 0 until frames.length()) {
            val frame = frames.optJSONObject(i) ?: continue
            val url = frame.optString("url").takeIf { it.isNotBlank() } ?: continue
            if (!hopSeen.add(url)) continue
            // Only ever step into a frame that fills the window. A 300×250 ad
            // slot is not a player, and navigating into one hijacks the page.
            if (!isDominantFrame(frame, frames.length())) continue
            hopCount++
            frameParent = from
            binding.syncLabel.text = "Following the embedded player…"
            binding.addressInput.setText(url)
            load(url, referer = from)
            return
        }
    }

    private fun relayBase(): String = SyncSession.serverUrl.ifBlank { SyncSession.savedServer(this) }

    /**
     * A frame worth navigating into: it covers most of the window, or its size
     * is unknown but it is the only frame on the page.
     */
    private fun isDominantFrame(frame: JSONObject, total: Int): Boolean {
        val ratio = frame.optDouble("ratio", 0.0)
        val w = frame.optInt("w", 0)
        val h = frame.optInt("h", 0)
        if (w <= 0 || h <= 0) return total == 1
        return ratio >= 0.30
    }

    private fun inject() {
        binding.webView.evaluateJavascript(Bridge.script(this), null)
    }

    private fun isDirectMedia(url: String): Boolean =
        Regex("\\.(mp4|m4v|webm|mkv|mov|m3u8|mpd)(\\?|#|$)", RegexOption.IGNORE_CASE).containsMatchIn(url)

    private fun handOffToPlayer(url: String) {
        val source = Source.guess(url)
        SyncSession.rememberLocal(source, 0.0, false)
        SyncSession.client?.load(source, 0.0, false)
        pausePageVideos()
        startActivity(Intent(this, WatchActivity::class.java))
        finish()
    }

    /** Silence the page before the native player takes over. */
    private fun pausePageVideos() {
        binding.webView.evaluateJavascript(
            "try{document.querySelectorAll('video').forEach(function(v){try{v.pause();}catch(e){}});}catch(e){}",
            null,
        )
    }

    // -------------------------------------------------------------- page events

    private fun onPageEvent(event: JSONObject) {
        // A page that frames its player has no <video> of its own to report —
        // step into the frame and leave the pending-seek state alone.
        if (event.optString("type") == "frames") {
            followEmbeddedPlayer(event)
            return
        }

        lastEvent = event
        renderStatus()

        val position = event.optDouble("position", 0.0)
        val paused = event.optBoolean("paused", true)

        pendingPosition?.let { target ->
            val tolerance = if (paused) 0.3 else 1.1
            if (Math.abs(position - target) > tolerance) {
                applyToPage(if (paused) "pause" else "play", target)
            } else if (!paused) {
                applyToPage("play", target)
            }
            pendingPosition = null
        }

        val now = SystemClock.elapsedRealtime()
        when (event.optString("type")) {
            "detected", "ready" -> shareCurrent(force = false)
            "play", "pause", "seeked" -> {
                if (now > suppressShareUntil) {
                    shareCurrent(force = false)
                    SyncSession.client?.let { client ->
                        when (event.optString("type")) {
                            "play" -> client.play(position)
                            "pause" -> client.pause(position)
                            else -> client.seek(position, paused)
                        }
                    }
                }
            }
            "blocked" -> binding.syncLabel.text = "Tap the video once so it can start"
            "time" -> {
                if (!paused && now - lastHeartbeat > 4000 && now > suppressShareUntil) {
                    lastHeartbeat = now
                    SyncSession.client?.play(position)
                }
            }
        }
    }

    /** Announce "this is what I'm watching" so the other device loads the same thing. */
    private fun shareCurrent(force: Boolean) {
        val event = lastEvent
        val client = SyncSession.client ?: return
        val reported = event?.optString("url")?.ifBlank { null } ?: binding.webView.url ?: return
        // Never share the relay's bounce page — share the player behind it.
        val pageUrl = Embeds.unwrap(reported, relayBase()) ?: reported
        if (SystemClock.elapsedRealtime() < suppressShareUntil && !force) return

        val rawSrc = event?.optString("src").orEmpty()
        val usableSrc = rawSrc.isNotBlank() &&
            !rawSrc.startsWith("blob:") &&
            !rawSrc.startsWith("mediasource:") &&
            !rawSrc.startsWith("data:")

        val title = event?.optString("title")?.ifBlank { null }

        val embedder = frameParent?.takeIf { it.isNotBlank() && it != pageUrl }
        val source = if (usableSrc) {
            Source(
                kind = if (rawSrc.contains(".m3u8")) "hls" else "file",
                url = rawSrc,
                pageUrl = embedder ?: pageUrl,
                title = title,
            )
        } else if (embedder != null) {
            // We stepped into a framed player: send the player *and* the site
            // that framed it, so the other side opens the very same player.
            Source(kind = "page", url = pageUrl, pageUrl = embedder, title = title)
        } else {
            Source(kind = "page", pageUrl = pageUrl, title = title)
        }

        if (!force && source.key() == sharedKey) return
        sharedKey = source.key()

        val position = event?.optDouble("position", 0.0) ?: 0.0
        val paused = event?.optBoolean("paused", true) ?: true
        client.load(source, position, paused)
        SyncSession.rememberLocal(source, position, paused)
        SyncSession.rememberRecent(this, source)
        binding.syncLabel.text = "Sharing “${source.displayTitle}”"
        SyncService.start(this, source.displayTitle, peerStatus())
    }

    // ------------------------------------------------------------------- sync

    override fun onSyncStatus(connected: Boolean) = renderStatus()

    override fun onPeers(peers: List<Peer>) = renderStatus()

    override fun onChat(message: ChatMessage) { /* chat lives in the player screen */ }

    private fun peerStatus(): String =
        SyncSession.partner?.let { "In sync with ${it.name}" } ?: getString(R.string.waiting_partner)

    private fun renderStatus() {
        val partner = SyncSession.partner
        binding.syncDot.setBackgroundResource(
            when {
                !SyncSession.connected -> R.drawable.dot_wait
                partner == null -> R.drawable.dot_idle
                else -> R.drawable.dot_live
            },
        )
        if (binding.syncLabel.text.isEmpty() || binding.syncLabel.text == getString(R.string.no_video_found)) {
            binding.syncLabel.text =
                if (lastEvent == null) getString(R.string.no_video_found) else peerStatus()
        }
    }

    override fun onRemote(message: JSONObject) {
        when (message.optString("t")) {
            "media" -> {
                val incoming = Source.fromJson(message.optJSONObject("source")) ?: return
                suppressShareUntil = SystemClock.elapsedRealtime() + 3000
                sharedKey = incoming.key()
                lastRemote = message

                val position = SyncClient.expectedPosition(message, SyncSession.client?.serverNow() ?: 0.0)
                val paused = message.optBoolean("paused", true)

                if (!incoming.isBrowserOnly && !incoming.isEmbed) {
                    // Direct media: native player does it better.
                    SyncSession.rememberLocal(incoming, position, paused)
                    pausePageVideos()
                    startActivity(Intent(this, WatchActivity::class.java))
                    finish()
                    return
                }

                val target = incoming.browserUrl() ?: incoming.pageUrl ?: return
                // The other side may have handed us a framed player plus the
                // site that framed it; players check exactly that.
                val embedder = incoming.pageUrl?.takeIf { it.isNotBlank() && it != target }
                pendingPosition = position
                pendingPlaying = !paused
                if (loadedTarget != target) load(target, embedder) else applyToPage(if (paused) "pause" else "play", position)
            }

            "play", "pause", "seek", "rate" -> {
                lastRemote = message
                val now = SyncSession.client?.serverNow() ?: 0.0
                if (SyncClient.isStale(message, now)) return
                val position = SyncClient.expectedPosition(message, now)
                val paused = when (message.optString("t")) {
                    "pause" -> true
                    "play" -> false
                    else -> message.optBoolean("paused", true)
                }
                suppressShareUntil = SystemClock.elapsedRealtime() + 1200
                applyToPage(if (paused) "pause" else "play", position)
            }
        }
    }

    private fun applyToPage(cmd: String, position: Double) {
        val script = Bridge.applyScript(cmd, position, tolerance = if (cmd == "pause") 0.3 else 1.1)
        binding.webView.evaluateJavascript(script, null)
    }

    companion object {
        /** How many framed players we will step into before giving up. */
        private const val MAX_HOPS = 3
        const val EXTRA_URL = "url"
        const val EXTRA_REFERER = "referer"
        const val EXTRA_SHARE = "share"
        const val EXTRA_POSITION = "position"
        const val EXTRA_PAUSED = "paused"
    }
}
