package com.ldrsync.app

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The in-app browser's eyes and hands.
 *
 * The injected script (shared/bridge.js) detects the page's <video>, reports
 * play/pause/seek/time, and accepts commands. This class is the only bridge
 * between that page and our sync loop.
 */
class Bridge(private val onEvent: (JSONObject) -> Unit) {

    @JavascriptInterface
    fun onEvent(payload: String) {
        val json = try {
            JSONObject(payload)
        } catch (_: Exception) {
            return
        }
        onEvent(json)
    }

    companion object {
        const val NAME = "FlickSyncNative"

        private var cached: String? = null

        /** shared/bridge.js is bundled as an asset (see app/build.gradle.kts). */
        fun script(context: Context): String {
            cached?.let { return it }
            val loaded = try {
                context.assets.open("bridge.js").bufferedReader().use { it.readText() }
            } catch (_: Exception) {
                ""
            }
            val value = loaded.ifBlank { FALLBACK }
            cached = value
            return value
        }

        /** Applies a command to the page's video element. */
        fun applyScript(cmd: String, position: Double, tolerance: Double = 0.35): String =
            "try{window.__flicksync&&window.__flicksync.apply({cmd:'$cmd',position:$position,tolerance:$tolerance});}catch(e){}"

        /**
         * Last-resort copy in case the asset is missing (e.g. a stripped build).
         * Kept tiny on purpose; the real implementation lives in shared/bridge.js.
         */
        private val FALLBACK = """
        (function(){
          if (window.__flicksync) return;
          var S={video:null,lastEmit:0};
          function post(o){var p=JSON.stringify(o);if(window.FlickSyncNative&&window.FlickSyncNative.onEvent)window.FlickSyncNative.onEvent(p);}
          function send(t,x){var v=S.video;var o={type:t,position:v?v.currentTime:0,duration:v?v.duration:0,paused:v?v.paused:true,src:v?(v.currentSrc||v.src||''):'',title:document.title,url:location.href};if(x)for(var k in x)o[k]=x[k];post(o);}
          function attach(v){if(!v||v.__bound)return;v.__bound=true;
            v.addEventListener('play',function(){send('play');});
            v.addEventListener('pause',function(){if(!v.ended)send('pause');});
            v.addEventListener('seeked',function(){send('seeked');});
            v.addEventListener('loadedmetadata',function(){send('ready');});
            v.addEventListener('timeupdate',function(){var n=Date.now();if(n-S.lastEmit<700)return;S.lastEmit=n;send('time');});}
          function pick(){var l=[].slice.call(document.querySelectorAll('video'));if(!l.length)return null;l.sort(function(a,b){return (b.clientWidth*b.clientHeight)-(a.clientWidth*a.clientHeight);});return l[0];}
          function scan(){var v=pick();if(v&&v!==S.video){S.video=v;attach(v);send('detected');}else if(v)attach(v);}
          window.__flicksync={scan:scan,apply:function(c){scan();var v=S.video||pick();if(!v)return false;
            try{if(c.position!==undefined&&Math.abs(v.currentTime-c.position)>(c.tolerance||0.35))v.currentTime=c.position;
            if(c.cmd==='play')v.play();else if(c.cmd==='pause')v.pause();return true;}catch(e){return false;}}};
          setInterval(scan,700);scan();
        })();
        """.trimIndent()
    }
}
