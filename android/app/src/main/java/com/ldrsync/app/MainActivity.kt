package com.ldrsync.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.ldrsync.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.nameInput.setText(SyncSession.savedName(this))
        binding.serverInput.setText(SyncSession.savedServer(this))
        binding.codeInput.setText(SyncSession.savedRoom(this))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        binding.serverToggle.setOnClickListener {
            binding.serverWrapper.visibility =
                if (binding.serverWrapper.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }

        binding.joinBtn.setOnClickListener { join() }
        binding.createBtn.setOnClickListener { create() }
        binding.leaveBtn.setOnClickListener {
            SyncSession.disconnect()
            SyncService.stop(this)
            binding.leaveBtn.visibility = View.GONE
            binding.status.text = "Left the room"
        }

        binding.codeInput.setOnEditorActionListener { _, _, _ ->
            join()
            true
        }

        renderRecent()
    }

    override fun onResume() {
        super.onResume()
        val inRoom = SyncSession.client != null
        binding.leaveBtn.visibility = if (inRoom) View.VISIBLE else View.GONE
        if (inRoom) {
            binding.status.text = "Room ${SyncSession.room} · ${peerText()}"
        }
    }

    private fun peerText(): String =
        if (SyncSession.isAlone) "waiting for them" else "${SyncSession.partner?.name} is here"

    private fun join() {
        val name = binding.nameInput.text?.toString()?.trim().orEmpty()
        val code = binding.codeInput.text?.toString()?.trim()?.uppercase()?.filter { it.isLetterOrDigit() }.orEmpty()
        if (name.isEmpty()) {
            binding.nameInput.requestFocus()
            toast("Add your name first")
            return
        }
        if (code.length < 4) {
            binding.codeInput.requestFocus()
            toast("Room codes are at least 4 characters")
            return
        }
        enter(name, code)
    }

    private fun create() {
        val name = binding.nameInput.text?.toString()?.trim().orEmpty()
        if (name.isEmpty()) {
            binding.nameInput.requestFocus()
            toast("Add your name first")
            return
        }
        val code = (1..6).map { ALPHABET.random() }.joinToString("")
        binding.codeInput.setText(code)
        enter(name, code)
    }

    private fun enter(name: String, code: String) {
        val server = binding.serverInput.text?.toString()?.trim().orEmpty()
            .ifEmpty { BuildConfig.SERVER_URL }

        binding.joinBtn.isEnabled = false
        binding.createBtn.isEnabled = false
        binding.status.text = "Connecting to $server…"

        SyncSession.connect(this, server, code, name)
        // Keep the socket alive while the phone is locked or the app is backgrounded.
        SyncService.start(this, "FlickSync · $code", "Connecting to the room…")

        // Give the socket a moment, then move on regardless: the room screen
        // shows the live connection state anyway.
        binding.root.postDelayed({
            binding.joinBtn.isEnabled = true
            binding.createBtn.isEnabled = true
            if (isFinishing || isDestroyed) return@postDelayed
            startActivity(Intent(this, WatchActivity::class.java))
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
        }, 450)
    }

    private fun renderRecent() {
        val items = SyncSession.recent(this)
        binding.recentSection.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        binding.recentList.removeAllViews()

        items.forEach { source ->
            val row = TextView(this).apply {
                text = source.displayTitle
                setTextColor(ContextCompat.getColor(context, R.color.text_dim))
                textSize = 13f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(R.drawable.bg_card)
                val padH = (14 * resources.displayMetrics.density).toInt()
                val padV = (11 * resources.displayMetrics.density).toInt()
                setPadding(padH, padV, padH, padV)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = (8 * resources.displayMetrics.density).toInt() }
                setOnClickListener {
                    SyncSession.rememberLocal(source, 0.0, true)
                    startActivity(Intent(this@MainActivity, WatchActivity::class.java))
                }
            }
            binding.recentList.addView(row)
        }
    }

    private fun toast(message: String) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    }
}
