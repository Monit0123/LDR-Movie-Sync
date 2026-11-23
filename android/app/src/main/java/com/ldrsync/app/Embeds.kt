package com.ldrsync.app

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * YouTube (and friends) refuse to start a player when the request carries no
 * HTTP Referer — the screen shows "Video player configuration error, error 153".
 *
 * A WebView that navigates straight to `/embed/<id>` sends no referer at all, so
 * the player never starts, even though the video is embeddable. A real page
 * that embeds the video would have sent one.
 *
 * Two remedies, both applied:
 *  - route the navigation through the relay's `/embed?u=` shim: a real page on
 *    our own origin that bounces to the player, so the browser attaches our
 *    origin as the referrer;
 *  - when no relay is known yet, attach a Referer header to the navigation.
 */
object Embeds {
    private val HOSTS = listOf(
        "youtube.com",
        "youtube-nocookie.com",
        "youtu.be",
        "dailymotion.com",
        "vimeo.com",
        "twitch.tv",
    )

    private const val FALLBACK_REFERER = "https://www.youtube.com/"
    private const val SHIM_PATH = "/embed?u="

    fun isEmbedUrl(raw: String): Boolean {
        val host = hostOf(raw)?.lowercase() ?: return false
        return HOSTS.any { host == it || host.endsWith(".$it") }
    }

    /** Relay-hosted bounce page for [raw], or [raw] itself when that is not needed. */
    fun wrap(raw: String, relay: String): String {
        if (raw.contains(SHIM_PATH) || !isEmbedUrl(raw)) return raw
        val base = relayBase(relay) ?: return raw
        return base + SHIM_PATH + URLEncoder.encode(raw, "UTF-8")
    }

    /** Recover the player URL from a shim URL, if that is what we were given. */
    fun unwrap(raw: String?, relay: String): String? {
        val value = raw?.trim().orEmpty()
        val base = relayBase(relay) ?: return null
        if (!value.startsWith("$base/embed?")) return null
        val inner = value.substringAfter("u=", "")
        if (inner.isBlank()) return null
        return try {
            URLDecoder.decode(inner, "UTF-8")
        } catch (_: Exception) {
            null
        }
    }

    /** What a browser would have sent had a real page embedded the video. */
    fun referer(relay: String): String {
        val base = relayBase(relay) ?: return FALLBACK_REFERER
        return if (base.startsWith("https://")) "$base/" else FALLBACK_REFERER
    }

    private fun relayBase(relay: String): String? {
        val base = relay.trim().trimEnd('/')
        return base.takeIf { it.startsWith("http://") || it.startsWith("https://") }
    }

    private fun hostOf(raw: String): String? = try {
        URI(raw.trim()).host
    } catch (_: Exception) {
        null
    }
}
