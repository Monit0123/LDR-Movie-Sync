package com.ldrsync.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Turns "a link someone pasted" into something we can play.
 * Uses the relay's /api/extract (it can read pages the phone's CORS would block)
 * and falls back to a local guess when the server is unreachable.
 */
object SourceResolver {

    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(18, TimeUnit.SECONDS)
        .build()

    fun resolve(context: Context, serverBase: String, rawUrl: String, callback: (Source?) -> Unit) {
        val cleaned = normalise(rawUrl)
        if (cleaned == null) {
            main.post { callback(null) }
            return
        }
        if (serverBase.isBlank()) {
            main.post { callback(Source.guess(cleaned)) }
            return
        }

        executor.execute {
            val resolved = try {
                val endpoint = serverBase.trimEnd('/') +
                    "/api/extract?url=" + java.net.URLEncoder.encode(cleaned, "UTF-8")
                http.newCall(Request.Builder().url(endpoint).header("accept", "application/json").build())
                    .execute()
                    .use { response ->
                        if (!response.isSuccessful) null
                        else {
                            val body = JSONObject(response.body?.string().orEmpty())
                            if (body.optBoolean("ok", false)) {
                                Source.fromJson(body.optJSONObject("source"))
                            } else null
                        }
                    }
            } catch (_: Exception) {
                null
            }

            val result = resolved ?: Source.guess(cleaned)
            main.post { callback(result) }
        }
    }

    private fun normalise(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        return when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            trimmed.contains(" ") -> "https://duckduckgo.com/?q=" + java.net.URLEncoder.encode(trimmed, "UTF-8")
            else -> "https://$trimmed"
        }
    }
}
