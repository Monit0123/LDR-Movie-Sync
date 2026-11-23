package com.ldrsync.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.Locale

data class Peer(
    val id: String,
    val name: String,
    val device: String,
) {
    val deviceLabel: String
        get() = when (device) {
            "android" -> "Android"
            "mac" -> "MacBook"
            else -> "Browser"
        }

    val initials: String
        get() = name.trim().split(" ").filter { it.isNotEmpty() }
            .map { it.first().uppercaseChar() }.joinToString("").take(2).ifEmpty { "?" }

    companion object {
        fun list(json: JSONArray?): List<Peer> {
            if (json == null) return emptyList()
            return (0 until json.length()).mapNotNull { i ->
                val o = json.optJSONObject(i) ?: return@mapNotNull null
                Peer(
                    id = o.optString("id"),
                    name = o.optString("name", "Guest"),
                    device = o.optString("device", "web"),
                )
            }
        }
    }
}

/**
 * What to play. `kind` mirrors the web client:
 *   file | hls | youtube | dailymotion | vimeo | twitch | page
 * "page" means: open the URL in the built-in browser and sync whatever video it finds.
 */
data class Source(
    val kind: String,
    val url: String? = null,
    val pageUrl: String? = null,
    val id: String? = null,
    val title: String? = null,
    val duration: Double = 0.0,
) {
    val isEmbed: Boolean get() = kind in EMBED_KINDS
    val isBrowserOnly: Boolean get() = kind == "page"
    val playableUrl: String? get() = url ?: pageUrl

    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: pageUrl?.let { prettyUrl(it) }
            ?: "Video"

    fun key(): String = "$kind|${id ?: url ?: pageUrl ?: ""}"

    /**
     * Where to point a WebView so that the platform player (YouTube,
     * Dailymotion, Vimeo) runs in the *top* document — that way our injected
     * bridge can reach its <video> element, which it could never do through a
     * cross-origin iframe.
     */
    fun browserUrl(): String? = when (kind) {
        "youtube" -> id?.let { "https://www.youtube.com/embed/$it?playsinline=1&rel=0&autoplay=0" }
        "dailymotion" -> id?.let { "https://www.dailymotion.com/embed/video/$it" }
        "vimeo" -> id?.let { "https://player.vimeo.com/video/$it" }
        // A hopped-into player lives in `url`; `pageUrl` is the site that
        // framed it (kept as the referrer). Plain pages keep them equal.
        else -> url ?: pageUrl
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("kind", kind)
        url?.let { put("url", it) }
        pageUrl?.let { put("pageUrl", it) }
        id?.let { put("id", it) }
        title?.let { put("title", it) }
        put("duration", duration)
    }

    companion object {
        private val EMBED_KINDS = setOf("youtube", "dailymotion", "vimeo", "twitch")
        private val MEDIA_EXT = Regex("\\.(mp4|m4v|webm|mkv|mov|m3u8|mpd)(\\?|#|$)", RegexOption.IGNORE_CASE)

        fun fromJson(o: JSONObject?): Source? {
            if (o == null) return null
            fun str(key: String): String? =
                o.optString(key, "").takeIf { it.isNotBlank() && it != "null" }
            return Source(
                kind = o.optString("kind", "file").ifBlank { "file" },
                url = str("url"),
                pageUrl = str("pageUrl"),
                id = str("id"),
                title = str("title"),
                duration = o.optDouble("duration", 0.0),
            )
        }

        /** Cheap guess used when the relay's /api/extract is unreachable. */
        fun guess(rawUrl: String): Source {
            val url = rawUrl.trim()
            val lower = url.lowercase()
            val id = when {
                lower.contains("youtu.be/") -> url.substringAfter("youtu.be/").substringBefore('?').substringBefore('&')
                lower.contains("youtube.com") -> Regex("[?&]v=([\\w-]+)").find(url)?.groupValues?.get(1)
                else -> null
            }
            if (id != null) return Source("youtube", pageUrl = url, id = id)
            Regex("dailymotion\\.com/video/([a-zA-Z0-9]+)").find(url)?.let {
                return Source("dailymotion", pageUrl = url, id = it.groupValues[1])
            }
            Regex("vimeo\\.com/(\\d+)").find(url)?.let {
                return Source("vimeo", pageUrl = url, id = it.groupValues[1])
            }
            return if (MEDIA_EXT.containsMatchIn(url)) {
                Source(
                    kind = if (lower.contains(".m3u8")) "hls" else "file",
                    url = url,
                    pageUrl = url,
                    title = url.substringAfterLast('/').substringBefore('?'),
                )
            } else {
                Source("page", pageUrl = url)
            }
        }

        fun prettyUrl(url: String): String = try {
            val u = java.net.URL(url)
            u.host.removePrefix("www.") + if (u.path.length > 1) u.path else ""
        } catch (_: Exception) {
            url
        }

        fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")
    }
}

fun Double.asClock(): String {
    val total = coerceAtLeast(0.0).toLong()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(Locale.US, "%d:%02d", m, s)
}
