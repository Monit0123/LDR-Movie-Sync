package com.ldrsync.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process (and therefore the socket and the decoder) alive while the
 * phone is locked or the app is in the background. That is the whole trick
 * behind "it keeps playing when she puts her phone down".
 */
class SyncService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            SyncSession.disconnect()
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "FlickSync"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "In sync"
        startForegroundCompat(title, text)
        return START_STICKY
    }

    private fun startForegroundCompat(title: String, text: String) {
        val notification = build(title, text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun build(title: String, text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, WatchActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, SyncService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText("FlickSync")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(0, "Leave room", stop)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Playback sync", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while you are watching together"
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val CHANNEL_ID = "flicksync.playback"
        private const val NOTIFICATION_ID = 4211
        const val ACTION_STOP = "com.ldrsync.app.STOP"

        fun start(context: Context, title: String, text: String) {
            val intent = Intent(context, SyncService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
            ContextCompat.startForegroundService(context, intent)
        }

        fun update(context: Context, title: String, text: String) {
            start(context, title, text)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, SyncService::class.java).setAction(ACTION_STOP))
        }

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
    }
}
