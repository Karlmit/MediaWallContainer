package com.kwa.mediawall

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.VideoView
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

class MainActivity : Activity() {
    private val executor = Executors.newFixedThreadPool(6)
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var root: FrameLayout
    private lateinit var wall: FrameLayout
    private lateinit var splash: TextView
    private lateinit var menuButton: Button
    private var overlayView: View? = null

    private var serverUrl = ""
    private var password = ""
    private var sessionCookie = ""
    private var itemCount = 6
    private var localOptimizedCache = false
    private var pinEnabled = false
    private var pinCode = ""
    private var allMedia = emptyList<MediaItem>()
    private var activeMedia = emptyList<MediaItem>()
    private var touchStartY = 0f
    private var touchStartTime = 0L
    private var menuVisible = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        hideSystemUi()
        prefs = getSharedPreferences("mediawall", MODE_PRIVATE)
        serverUrl = prefs.getString("serverUrl", "") ?: ""
        password = prefs.getString("password", "") ?: ""
        itemCount = prefs.getInt("itemCount", 6)
        localOptimizedCache = prefs.getBoolean("localOptimizedCache", false)
        pinEnabled = prefs.getBoolean("pinEnabled", false)
        pinCode = prefs.getString("pinCode", "") ?: ""
        buildRoot()
        if (pinEnabled && pinCode.isNotBlank()) {
            showPinScreen()
        } else if (serverUrl.isBlank()) {
            showSetupScreen()
        } else {
            connectAndLoad()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    private fun hideSystemUi() {
        window.decorView.windowInsetsController?.let {
            it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun buildRoot() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(5, 5, 7)) }
        wall = FrameLayout(this)
        splash = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 28f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(190, 8, 9, 13))
            visibility = View.GONE
        }
        menuButton = Button(this).apply {
            text = "MediaWall Android"
            alpha = 0.88f
            setOnClickListener { showSetupScreen() }
        }
        root.addView(wall, FrameLayout.LayoutParams(-1, -1))
        root.addView(menuButton, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply {
            setMargins(0, 16, 16, 0)
        })
        root.addView(splash, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER).apply {
            setMargins(24, 24, 24, 24)
        })
        root.setOnTouchListener { _, event -> handleWallTouch(event) }
        setContentView(root)
    }

    private fun handleWallTouch(event: MotionEvent): Boolean {
        if (menuVisible) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchStartY = event.y
                touchStartTime = System.currentTimeMillis()
                return true
            }
            MotionEvent.ACTION_UP -> {
                val dy = event.y - touchStartY
                val quickEnough = System.currentTimeMillis() - touchStartTime < 900
                if (quickEnough && kotlin.math.abs(dy) > 80) {
                    changeItemCount(if (dy < 0) 1 else -1)
                    return true
                }
            }
        }
        return true
    }

    private fun showPinScreen() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        menuVisible = true
        wall.removeAllViews()
        showOverlay(panel("Unlock MediaWall").apply {
            val pinInput = input("PIN", true)
            addView(pinInput)
            addView(button("Unlock") {
                if (pinInput.text.toString() == pinCode) {
                    clearOverlay()
                    menuVisible = false
                    if (serverUrl.isBlank()) showSetupScreen() else connectAndLoad()
                } else {
                    toast("Wrong PIN")
                }
            })
        })
    }

    private fun showSetupScreen() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        menuVisible = true
        wall.removeAllViews()
        val panel = panel("MediaWall Android")
        val urlInput = input("Docker URL, for example http://192.168.1.10:3060", false).apply {
            setText(serverUrl)
        }
        val passwordInput = input("Docker password", true).apply {
            setText(password)
        }
        val cacheToggle = CheckBox(this).apply {
            text = "Download optimized videos into private app storage"
            setTextColor(Color.WHITE)
            isChecked = localOptimizedCache
        }
        val pinToggle = CheckBox(this).apply {
            text = "Lock app behind PIN"
            setTextColor(Color.WHITE)
            isChecked = pinEnabled
        }
        val pinInput = input("PIN", true).apply {
            setText(pinCode)
        }
        panel.addView(urlInput)
        panel.addView(passwordInput)
        panel.addView(cacheToggle)
        panel.addView(pinToggle)
        panel.addView(pinInput)
        panel.addView(button("Connect") {
            serverUrl = normalizeServerUrl(urlInput.text.toString())
            password = passwordInput.text.toString()
            localOptimizedCache = cacheToggle.isChecked
            pinEnabled = pinToggle.isChecked
            pinCode = pinInput.text.toString()
            prefs.edit()
                .putString("serverUrl", serverUrl)
                .putString("password", password)
                .putBoolean("localOptimizedCache", localOptimizedCache)
                .putBoolean("pinEnabled", pinEnabled)
                .putString("pinCode", pinCode)
                .apply()
            clearOverlay()
            menuVisible = false
            connectAndLoad()
        })
        panel.addView(button("Clear private video cache") {
            File(filesDir, "optimized").deleteRecursively()
            toast("Private cache cleared")
        })
        showOverlay(panel)
    }

    private fun panel(title: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 24, 28, 24)
            setBackgroundColor(Color.argb(235, 18, 19, 24))
            addView(TextView(context).apply {
                text = title
                setTextColor(Color.WHITE)
                textSize = 22f
                setPadding(0, 0, 0, 18)
            })
        }
    }

    private fun centeredPanelParams(): FrameLayout.LayoutParams {
        return FrameLayout.LayoutParams(
            min(resources.displayMetrics.widthPixels - 40, 760),
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        )
    }

    private fun showOverlay(content: View) {
        clearOverlay()
        val scroll = ScrollView(this).apply {
            setPadding(0, 20, 0, 20)
            addView(content)
        }
        overlayView = scroll
        root.addView(scroll, centeredPanelParams())
    }

    private fun clearOverlay() {
        overlayView?.let { root.removeView(it) }
        overlayView = null
    }

    private fun input(hintText: String, passwordField: Boolean): EditText {
        return EditText(this).apply {
            hint = hintText
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(166, 167, 173))
            setSingleLine(true)
            if (passwordField) inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
    }

    private fun button(label: String, action: View.() -> Unit): Button {
        return Button(this).apply {
            text = label
            setOnClickListener { action() }
        }
    }

    private fun connectAndLoad() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        showCenter("Connecting")
        executor.execute {
            try {
                loginIfNeeded()
                val media = fetchMedia()
                mainHandler.post {
                    allMedia = media
                    activeMedia = pickActiveMedia()
                    renderWall()
                    showCenter("Loaded ${allMedia.size} items", 900)
                }
            } catch (error: Exception) {
                mainHandler.post {
                    showCenter("Connection failed: ${error.message}", 3500)
                    showSetupScreen()
                }
            }
        }
    }

    private fun loginIfNeeded() {
        if (password.isBlank()) return
        val body = "password=${java.net.URLEncoder.encode(password, "UTF-8")}"
        val connection = (URL("$serverUrl/login").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            outputStream.use { it.write(body.toByteArray()) }
        }
        val status = connection.responseCode
        sessionCookie = connection.headerFields["Set-Cookie"]?.firstOrNull()?.substringBefore(";") ?: ""
        connection.inputStreamOrError().close()
        if (status !in 200..399 || sessionCookie.isBlank()) {
            throw IllegalStateException("login failed, check password")
        }
    }

    private fun fetchMedia(): List<MediaItem> {
        val text = requestText("$serverUrl/api/media")
        val result = org.json.JSONObject(text)
        val array = result.optJSONArray("media") ?: JSONArray()
        return List(array.length()) { index ->
            val obj = array.getJSONObject(index)
            MediaItem(
                id = obj.getString("id"),
                name = obj.optString("name", obj.getString("id")),
                type = obj.getString("type"),
                path = obj.optString("path", obj.getString("id")),
                url = absoluteUrl(obj.getString("url")),
                optimizedUrl = obj.optString("optimizedUrl").takeIf { it.isNotBlank() && it != "null" }?.let(::absoluteUrl),
                fallbackUrl = obj.optString("fallbackUrl").takeIf { it.isNotBlank() && it != "null" }?.let(::absoluteUrl)
            )
        }
    }

    private fun requestText(url: String): String {
        val connection = open(url)
        val status = connection.responseCode
        val body = connection.inputStreamOrError().bufferedReader().use { it.readText() }
        if (status == 401) throw IllegalStateException("unauthorized, check password")
        if (status !in 200..299) throw IllegalStateException("HTTP $status")
        return body
    }

    private fun open(url: String): HttpURLConnection {
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            if (sessionCookie.isNotBlank()) setRequestProperty("Cookie", sessionCookie)
        }
    }

    private fun HttpURLConnection.inputStreamOrError() = try {
        inputStream
    } catch (_: Exception) {
        errorStream ?: throw IllegalStateException("HTTP $responseCode")
    }

    private fun normalizeServerUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
        return "http://$trimmed"
    }

    private fun absoluteUrl(url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        return "$serverUrl$url"
    }

    private fun pickActiveMedia(): List<MediaItem> {
        if (allMedia.isEmpty()) return emptyList()
        return allMedia.shuffled().take(min(itemCount, allMedia.size))
    }

    private fun renderWall() {
        wall.removeAllViews()
        if (activeMedia.isEmpty()) {
            showCenter("No media found")
            return
        }
        layoutTiles(activeMedia.size).forEachIndexed { index, rect ->
            val item = activeMedia[index]
            val tile = FrameLayout(this).apply { setBackgroundColor(Color.rgb(17, 18, 23)) }
            val progress = ProgressBar(this)
            tile.addView(progress, FrameLayout.LayoutParams(56, 56, Gravity.CENTER))
            wall.addView(tile, FrameLayout.LayoutParams(rect.width, rect.height).apply {
                leftMargin = rect.x
                topMargin = rect.y
            })
            loadTile(tile, progress, item)
        }
    }

    private fun layoutTiles(count: Int): List<TileRect> {
        val width = resources.displayMetrics.widthPixels
        val height = resources.displayMetrics.heightPixels
        if (count == 1) {
            val itemWidth = (width * 0.92).roundToInt()
            val itemHeight = (height * 0.92).roundToInt()
            return listOf(TileRect((width - itemWidth) / 2, (height - itemHeight) / 2, itemWidth, itemHeight))
        }
        val columns = ceil(kotlin.math.sqrt(count.toDouble() * width / max(1, height))).roundToInt().coerceAtLeast(1)
        val rows = ceil(count.toDouble() / columns).roundToInt().coerceAtLeast(1)
        val tileWidth = width / columns
        val tileHeight = height / rows
        return List(count) { index ->
            TileRect((index % columns) * tileWidth, (index / columns) * tileHeight, tileWidth, tileHeight)
        }
    }

    private fun loadTile(tile: FrameLayout, progress: ProgressBar, item: MediaItem) {
        if (item.type == "image") {
            executor.execute {
                try {
                    val bitmap = BitmapFactory.decodeStream(open(item.url).inputStream)
                    mainHandler.post {
                        tile.removeView(progress)
                        tile.addView(ImageView(this).apply {
                            scaleType = ImageView.ScaleType.CENTER_CROP
                            setImageBitmap(bitmap)
                        }, FrameLayout.LayoutParams(-1, -1))
                    }
                } catch (_: Exception) {
                    mainHandler.post { tileFailed(tile, progress) }
                }
            }
            return
        }

        executor.execute {
            val playbackUrl = if (localOptimizedCache) cachedVideoUrl(item) else item.bestRemoteVideoUrl()
            mainHandler.post {
                tile.removeView(progress)
                tile.addView(VideoView(this).apply {
                    setVideoURI(Uri.parse(playbackUrl))
                    setOnPreparedListener { player ->
                        player.isLooping = true
                        player.setVolume(0f, 0f)
                        start()
                    }
                    setOnErrorListener { _, _, _ ->
                        tileFailed(tile, null)
                        true
                    }
                    start()
                }, FrameLayout.LayoutParams(-1, -1))
            }
        }
    }

    private fun cachedVideoUrl(item: MediaItem): String {
        val sourceUrl = item.optimizedUrl ?: item.fallbackUrl ?: item.url
        val cacheDir = File(filesDir, "optimized").apply { mkdirs() }
        val cacheFile = File(cacheDir, "${sha256(sourceUrl)}.mp4")
        if (cacheFile.exists() && cacheFile.length() > 0) return cacheFile.toURI().toString()
        showCenter("Downloading private optimized video", 900)
        val connection = open(sourceUrl)
        connection.inputStream.use { input ->
            FileOutputStream(cacheFile).use { output -> input.copyTo(output) }
        }
        return cacheFile.toURI().toString()
    }

    private fun MediaItem.bestRemoteVideoUrl(): String {
        return optimizedUrl ?: fallbackUrl ?: url
    }

    private fun tileFailed(tile: FrameLayout, progress: ProgressBar?) {
        progress?.let { tile.removeView(it) }
        tile.addView(TextView(this).apply {
            text = "Failed"
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, -1))
    }

    private fun changeItemCount(delta: Int) {
        itemCount = (itemCount + delta).coerceIn(1, max(1, allMedia.size))
        prefs.edit().putInt("itemCount", itemCount).apply()
        activeMedia = pickActiveMedia()
        renderWall()
        showCenter("$itemCount items", 900)
    }

    private fun showCenter(message: String, durationMs: Long = 0) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { showCenter(message, durationMs) }
            return
        }
        splash.text = message
        splash.visibility = View.VISIBLE
        if (durationMs > 0) {
            mainHandler.postDelayed({ splash.visibility = View.GONE }, durationMs)
        }
    }

    private fun toast(message: String) {
        showCenter(message, 1200)
    }

    private fun sha256(text: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }

    data class MediaItem(
        val id: String,
        val name: String,
        val type: String,
        val path: String,
        val url: String,
        val optimizedUrl: String?,
        val fallbackUrl: String?
    )

    data class TileRect(val x: Int, val y: Int, val width: Int, val height: Int)
}
